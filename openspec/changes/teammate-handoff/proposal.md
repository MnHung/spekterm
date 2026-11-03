## Why

With `team-membership` a spekterm can be on a spekterm-server team, but nothing travels over the connection yet.
This change delivers the server's milestone M1 on the spekterm side: an agent hands work **to a person** — a
teammate — and the teammate's spekterm receives it in its inbox, at once if it is open or at its next connection if
it is not (spekterm-server PRD §6.2–§6.3, protocol §5 `handoff.send` / `handoff.received`, §10, §11). Today such a
request is a chat message that is not seen, is costly to start, and is forgotten; a handoff arrives with a count
and a notification and turns into a ready session.

## What Changes

- **An agent can address a teammate**: a delivery in its outbox with `"to": "<handle>"` instead of `"target"` is a
  handoff to that teammate. `to` and `target` together, or `to` with `at` / `repeat`, are refused. A handle that is
  not a teammate's is refused at once, without asking the user.
- **Nothing leaves the computer before the user sees it**: a teammate handoff waits in a new **Outgoing** tab of the
  inbox showing the recipient, the source session, the title and the **full body** as it will be sent, with
  **Send** and **Discard**. It counts in the inbox badge and raises a desktop notification. There is no setting
  that sends without confirmation.
- **Sending is safe to retry**: a confirmed handoff keeps its `clientId` until the server answers, is sent when the
  connection is (back) up, waits out a rate limit, and is resent with the same `clientId` after a lost answer.
- **The agent's receipt follows the handoff**: `awaiting-confirmation` when it is read, then `sent`, `discarded`, or
  `rejected` with the server's error code; `held` while a confirmed handoff waits for the connection or a rate
  limit.
- **Agents are told about teammates**: the introduction gains a short paragraph — only when the user is on a team
  with the feature on — that names the `to` form and the confirmation and tells the agent to read a teammates file
  before writing one. That file (kept current) states every rule of a teammate handoff and lists each teammate's
  handle and display name. The introduction's size does not grow with the team, and nothing a teammate wrote enters
  it.
- **A teammate's handoff arrives in the inbox** as a new source, "teammate": the sender is the server's verified
  `from`, never parsed from the text. It goes through the existing acceptance gate, folder choice and filled-but-not-
  sent first prompt, as third-party text — with the **same-machine handoff's body limit (20,000)**, not the 4,000 of
  other third-party text (spekterm-server PRD §7.2, decided 2026-11-03).
- **The receiving rules that the server's delivery guarantee rests on** (protocol §11) are followed: store hidden,
  then acknowledge, show only after the acknowledgement is answered; acknowledge again a handoff already stored;
  resend unanswered acknowledgements after reconnecting; drop what was delivered elsewhere or expired; show what the
  server lost; drop unacknowledged ones when the credential is discarded; keep an offer in memory while the inbox is
  full.
- **BREAKING (introduction size)**: the introduction's budget for its longest variant is raised from 8,000 to 8,500
  characters (still below the 9,000 hard limit and the CLI's 10,000 threshold), after re-measuring that threshold
  with the CLI in use.
- **The sending side and the server disagree on nothing the user confirmed**: a teammate handoff is bound to the
  membership it was read under, and a send that may have reached the server is never offered for a retry under
  another.

## Capabilities

### New Capabilities

- `teammate-handoff`: handing work to a teammate (the `to` field, local checks, the Outgoing confirmation, sending
  and resending, the teammates file) and receiving a teammate's handoff (the hidden store, acknowledgements, the
  `teammate` inbox source and its fields).

### Modified Capabilities

- `agent-handoff-source`: "agent 於 session 啟動時被告知…" states the teammate paragraph and the teammates file,
  and the budget becomes 8,000 → 8,500 for the longest variant, which now includes a team.
- `handoff-receipt`: "A receipt states one of six outcomes" gains `awaiting-confirmation`, `sent` and `discarded`,
  and server codes on `rejected` and `held`; "A receipt is the outcome of reading, not of the work" allows a teammate
  handoff's receipt to be rewritten when the user decides and the server answers.
- `project-website`: "The documentation states the app's network behavior" (as `team-membership` leaves it) adds
  handoffs to what passes through and what the team server keeps. **This delta assumes `team-membership` is archived
  first.**
- `agent-intake`: "使用者在接受之前看得到本文全文…" — a teammate's handoff passes the acceptance gate with the
  handoff body limit; "未處理的項目數…" — teammate handoffs awaiting confirmation count in the badge.

Checked and unchanged: `intake-routing` (a teammate's handoff carries no resolved folder, so the rules preselect; its
`originKind`/`originId` come from the server for this adapter, but a file in the shared drop point can declare the
same values, so a routing rule on them is not proof of a teammate — the inbox's teammate label follows the adapter), `remote-protocol` (teammate items are ordinary
inbox items in `inbox.list` and accepted as any other; the Outgoing confirmation is desktop-only and is not an
operation), `handoff-completion` (a session opened from a teammate's handoff is not a handed-off child; reporting
back to the sender is M2), `session-lineage` (no lineage across people).

## Impact

- **Main process (new)**: `src/main/teammate-outbox.ts` (reading a `to` delivery, the outgoing store
  `<userData>/team-outgoing.json`, send and resend), `src/main/teammate-inbox.ts` (the hidden store
  `<userData>/team-incoming.json`, acknowledgements, delivery into the inbox), and
  `src/main/teammates-file.ts`.
- **Main process (changed)**: `handoff-delivery.ts` (`to` in the payload), `handoff-service.ts` (routing a `to`
  delivery), `handoff-receipt.ts` (statuses, rewriting), `handoff-intro.ts` (the paragraph, the budget),
  `intake-schema.ts` (a handoff-body flag apart from `firstPartyBody`; `targetFolderId` optional in provenance),
  `intake-rejection.ts` and `agent-protocol-copy.ts` (new codes and reasons), the notification wiring, the badge
  count.
- **IPC / renderer**: the inbox snapshot carries the outgoing items; `ipc/intake.ts` gains Send, Discard, Dismiss;
  `IntakeOverlay.tsx` (the Outgoing tab), the badge, the teammate source's label; dictionary strings in `en.json` and
  `zh-TW.json`.
- **Probes**: `probe:team` gains send and receive sections against the stub team server (two app profiles or the
  stub as the other side); `probe:intake` regression for the receipt and badge.
- **Docs**: the website's handoffs and Teams pages in both languages, `docs/lessons/team.md`, `CLAUDE.md` 現況.
- **Depends on** `team-membership` (the connection, `request`, `onEvent`, `onCredentialDiscarded`, the members list).
