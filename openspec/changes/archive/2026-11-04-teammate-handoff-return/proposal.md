## Why

`teammate-handoff` (the server's milestone M1 on the spekterm side) sends work to a teammate and stops there: the
sender sees "sent" and nothing after it, and the teammate's agent has no way to say it finished. spekterm-server 0.3.0
(`handoff-return`, archived 2026-11-03) adds the way back — `handoff.update` for the recipient's reports and
`handoff.sync` / `handoff.status` for the sender's list (protocol v1 draft, §5, §10, §12). This change is the
spekterm client for it (spekterm-server PRD §6.3–§6.5, §10, §13.1). It must land before a spekterm release ships a
client for protocol v1, while the protocol can still change.

## What Changes

- **A Sent list**: a new **Sent** tab in the inbox lists every handoff this member sent to a teammate, with its
  status (pending, delivered, taken, declined, done, expired), how long it has been in it, the recipient (marked when
  they left the team), the decline reason or the latest report as plain third-party text, and the title for
  handoffs sent from this device (none for those sent from another device or before reinstalling).
- **The list follows the server**: after every authentication spekterm pages `handoff.sync` from the last stored
  sequence number, then applies `handoff.status` events, following the sending rules of protocol §12 (a record
  stored before its sequence number, older records ignored, a reset kept durable until it finishes, a 1011 close
  reconnected and synced again).
- **A notification when a handoff ends**: `done`, `declined` and `expired` raise a desktop notification only on the
  device that sent the handoff; the member's other devices update their list quietly.
- **The sending agent sees the status, not the text**: the relations file of the session that sent a teammate
  handoff lists it with its status. The report and the decline reason are a teammate's text and never enter that
  agent's context; the user reads them in the Sent list and may pass them on.
- **A session opened from a teammate's handoff is linked to it**: the link is written before the session spawns
  (through the existing single-use spawn ticket), is not a lineage (no parent across people), and survives restarts.
- **The receiving side reports back**: `taken` once the session has actually started on the handoff (the user sent
  the filled-in prompt and the agent started working), `declined` when the user declines the inbox item with an optional reason of at most 500 code units, `done`
  with the linked session agent's completion report. Reports of one handoff are sent one at a time, in order,
  resending the same report after a lost answer; a refusal that ends reporting leaves a visible trace, and later
  reports from that session are refused with a receipt that says so. Only a handoff whose acknowledgement was
  answered, on this device, by a server that offers `handoff.update` is reported on; anything else is accepted as
  today, without Decline and without the report paragraph.
- **The receiving agent is told it can report**: its introduction carries the completion-report paragraph with a
  variant for a teammate's handoff (the report goes to the teammate through the team server), no longer than the
  existing variant. The recipient is notified of the report like any completion, focused on the session.
- **Text sent back is the text accepted**: reasons and reports go through normalization, then `toWellFormed()`,
  then the length check, the path `teammateText` already uses.

## Capabilities

### New Capabilities

- `teammate-handoff-return`: the Sent list and its synchronization, the sender's notifications, the sending
  session's view of its teammate handoffs, the link between a session and a teammate's handoff, declining, and the
  reports sent back (`taken`, `declined`, `done`) with their ordering, retry and stop rules.

### Modified Capabilities

- `handoff-completion`: "由交接建立的 session，其 agent 被告知如何宣告完成" — a session opened from a teammate's
  handoff is told too, with a variant of the paragraph; "完成報告經該 session 自己的投遞落點送達…" — such a session's
  report is adopted and sent to the teammate, and is refused once reporting for its handoff has stopped or it was
  declined; "完成報告被採納時發出作業系統通知…" — its notification focuses the session, with no handoff sheet.
- `project-website`: "The documentation states the app's network behavior" — what passes through the team server
  and what it keeps gains decline reasons and reports (30 days) and the Sent list's records (90 days). Based on the main spec as `teammate-handoff` left it.

Checked and unchanged: `session-lineage` (the teammate link is a separate field; no parent across people, nothing on
the rail nests), `remote-protocol` (a paired phone sees teammate items as ordinary inbox items and can ignore one;
decline and the Sent list are desktop-only in this change, so no operation is added), `agent-intake` (declining is
stated for the `teammate` adapter in the new capability; ignoring stays what it is and tells the sender nothing),
`teammate-handoff` (its requirements stand as written; this change adds behavior beside them).

## Impact

- **Main process (new)**: `src/main/teammate-sent.ts` (the Sent store `<userData>/team-sent.json`, the sync loop,
  events, notifications), `src/main/teammate-return.ts` (the report store `<userData>/team-return.json` and the
  serial report queue).
- **Main process (changed)**: `teammate-inbox.ts` (`answered` and the device on an entry, longer retention),
  `teammate-outbox.ts` (a sent item is recorded in the Sent store before it leaves the
  outgoing store), `handoff-ticket.ts` (tickets for teammate records, the link in the resolution),
  `session-create.ts` / `ipc/terminal.ts` / `index.ts` (the link at spawn, `reportable`), `session-store.ts` (a
  main-owned `teammateHandoff` field), `team-outcome.ts` (close 1011 named), `handoff-completion.ts` / `handoff-service.ts` (a linked
  session's report), `handoff-intro.ts` (the teammate variant of the report paragraph), `handoff-relations.ts`
  (`teammateHandoffs` for the sending session), `teammates-file.ts` (the rules explain that field), `ipc/intake.ts`
  (`taken` when the user sends the prompt, Decline, the Sent list call), `intake-notify.ts` (a Sent arrival kind), `intake-rejection.ts` /
  `agent-protocol-copy.ts` (`TEAMMATE_REPORT_STOPPED`, `TEAMMATE_REPORT_NOT_SENT`).
- **Renderer**: `IntakeOverlay.tsx` (the Sent tab, Decline with a reason), dictionary strings in `en.json` and
  `zh-TW.json`.
- **Probes**: `probe:team` gains sync, status, report and decline sections; the stub team server
  (`scripts/lib/stub-team-server.mjs`) gains `handoff.update`, `handoff.sync`, `handoff.status` and a scripted 1011.
- **Docs**: the website's Teams and handoffs pages and the data-and-network page in both languages,
  `docs/lessons/team.md`, `CLAUDE.md` 現況.
- **Depends on** `teammate-handoff` (archived 2026-11-04; it builds on its stores) and spekterm-server 0.3.1 (protocol v1
  draft, `docs/protocol.md` as of commit 3807d44: rule 4's wording, rules 2–3 under a reset, `seq` in the send's
  answer; design Context).
