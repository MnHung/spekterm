## Why

An agent can schedule a handoff (`at`) and propose a repeating one (`repeat`), but nothing it writes can take one
back. In practice the user plans these in conversation ("run the report every Wednesday", then a day later "skip
it this week", "make it Thursdays", "stop it"), and every undo has to be done by hand in the inbox's Schedules tab.
Adding works through the agent and removing does not, so a conversation that changes its mind leaves stale work
scheduled. The user also expects to ask for this from **any** session, not only from the one that scheduled the
handoff: the session that wrote it is often closed by the time the plan changes.

## What Changes

- A new outbox delivery, `{"kind": "cancel", "id": "<id>"}`, cancels one item that the inbox's Schedules tab
  lists, with the same effect as the desktop's own action on it:
  - a one-off scheduled handoff → Cancel (it never opens);
  - an upcoming occurrence of a recurrence → Skip (this time never opens, the recurrence continues);
  - a proposal waiting for approval → Decline;
  - an approved recurrence → Stop repeating, **without the desktop's confirmation** (the user's ruling).
- **Any agent session may cancel any of them**, not only the session that wrote it (the user's ruling). The
  outbox gives no authority anyway (`agent-handoff-source`: it is not a security boundary).
- Only what the Schedules tab lists can be cancelled. A handoff whose opening has begun, an opened one, a stopped
  or ended recurrence, and items from other producers (Slack, a teammate) are refused; a cancel never closes a
  session (that is `agent-session-control`'s close).
- **There is no "edit"**: a change is a new handoff plus a cancel of the old one. The rules tell the agent to write
  the new one first and cancel the old one only after the new one's receipt says it was accepted or
  scheduled — and, for a recurrence, only once the user has approved the new one — so a refused or unapproved
  replacement does not leave nothing. A changed recurrence is a new proposal that the user
  approves again; nothing an agent writes can create an approved recurrence.
- **A schedules file**, `<userData>/handoff/schedules.json`, lists what can be cancelled (id, kind, title, target
  folder, time or expression, source, the start of the body) and states the cancel rules. It is rewritten when
  the inbox changes. The introduction gets one sentence pointing to it, as the teammate paragraph points to the
  teammates file: the introduction has 224 characters left under its budget (measured: 8,276 of 8,500).
- **The `scheduled` and `proposed` receipts carry the item's `id`**, so the session that wrote a handoff can cancel
  it without reading the schedules file.
- A cancel's receipt is `accepted` when it was carried out (a cancel takes effect when it is read, unlike a close),
  `duplicate` when the item was already cancelled (no trace: the state it asks for holds), or `rejected` with a code
  saying the id names nothing that can be cancelled, or that the recurrence store is unavailable (temporary). A
  refused cancel is visible to the user as other refused deliveries are.
- **What agents cancelled is listed quietly** in a section of the Schedules tab for 7 days (title, what was done,
  which session, when): no notification and no count. Any session can cancel and an agent's stop asks nothing, so a
  session misled by third-party text could otherwise stop the user's plans unseen.
- The website's handoff documentation, in both languages, describes cancelling and changing a scheduled or
  repeating handoff.

## Capabilities

### New Capabilities

- `handoff-cancel`: the cancel delivery — its shape, what it can name, what each cancel does, who may write it,
  its receipt and its refusals; the schedules file — location, content, when it is written.

### Modified Capabilities

- `handoff-receipt`: a cancel gets a receipt; the `scheduled`, `proposed` and `duplicate` receipts carry the item's
  id; `accepted` for a cancel means it was carried out, `duplicate` that it was already cancelled.
- `agent-handoff-source`: the introduction points to the schedules file for cancelling and changing scheduled and
  repeating handoffs.
- `agent-session-control`: the list of outbox kinds that are not refused gains the cancel.
- `recurring-handoff`: Stop repeating can also come from an agent, without confirmation; "stopping is not one
  click" is now true of the desktop only.

## Impact

- Code: `src/main/handoff-delivery.ts` (the new kind), `src/main/handoff-service.ts` (routing it), a new
  `src/main/handoff-cancel.ts` (the decision and the action) and `src/main/schedules-file.ts` (the file),
  `src/main/handoff-receipt.ts` (`id`), `src/main/handoff-intro.ts` (one sentence), `src/main/intake-schema.ts` /
  `src/main/intake-rejection.ts` / `src/main/agent-protocol-copy.ts` (new codes and their reasons),
  `src/main/handoff-outbox.ts` (the file's path), `src/main/index.ts` (wiring).
- UI: the Schedules tab's "Cancelled by an agent" section (`IntakeOverlay.tsx`), and its text and the refusal codes'
  trace text in `src/shared/i18n/en.json` and `zh-TW.json`.
- Remote protocol: unchanged. A device sees the result through the inbox list it already follows.
- Tests: unit tests for the decision, the action, the file and the receipt; a `probe:intake` section through the
  real outbox; rows in `scripts/scenario-coverage.test.mjs`.
- Docs: `docs/lessons/handoff.md`, `CLAUDE.md`'s handoff summary, `site/src/content/docs/docs/using/handoffs.md`
  and its `zh-tw` counterpart.
