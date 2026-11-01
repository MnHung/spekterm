## 1. Record whether a session is running (main process)

- [x] 1.1 `src/main/session-store.ts`: add `running?: true` to `PersistedSession` and `MainOwnedField`; in `replace()`
  take it from the pending main fields, the existing entry or the provisional one (as `claudeSessionId` / `cwd`);
  accept only the literal `true` in `parseSessionEntry`; add it to `update()`'s patch type
- [x] 1.2 New `src/main/session-running.ts` (no `electron` import): the record rules — spawn sets `running`, a
  successful hibernation clears it, `disposed` leaves it
- [x] 1.3 `src/main/ipc/terminal.ts`: call it from the sink's `spawned` and `hibernated` exit, and from the
  `hibernate` handler when `service.hibernate()` returns true; in `releaseRenderer`, flush before
  `dropProvisional()`
- [x] 1.4 Restore answer and preload types: carry `running` per entry (added explicitly to `RestoredSession`)
- [x] 1.5 `src/main/user-env.ts`: expose whether the resolution failed or timed out (distinct from skipped); the
  wake IPC accepts an automatic flag and, for a `claude` target, refuses with a distinct code when it failed
- [x] 1.6 Unit tests (`session-store.test.ts`, `session-running.test.ts`, `user-env` / wake refusal; all covered by
  the `test:unit` glob): round-trip of `running`; a renderer `persist` cannot set or clear it; a non-`true` value is
  dropped; `update()` before the entry exists and while provisional both land in `replace()`; an entry without
  the field reads as not running; spawn sets, hibernation clears, `disposed` keeps — each with a control (remove
  the line ⇒ red); the automatic `claude` wake is refused after a failed or timed-out resolution and allowed after
  a skipped one
- [x] 1.7 Unit test for the flush order: a session whose renderer is released before its first `persist` keeps
  `running`, `lineage` and `peerName` on disk (control: the old order ⇒ red)

## 2. Start them after restore (renderer)

- [x] 2.1 `sessions.tsx`: `wake(id, { launch: true })` sets a launch mark that `focus()` does not clear and passes
  the automatic flag to the main process; a normal `wake()` clears it
- [x] 2.2 `sessions.tsx`: in the restore `.then`, record the `running` ids in persisted order; an effect gated on
  `restored` (plus a ref gate for StrictMode) walks them — skips a session that is gone, not dormant, or in
  `waking`; shells are not held back; the environment refusal stops further `claude` starts; the first `claude` is
  the canary (7 s from its `wake` resolving; only `status === 'exited'` stops the walk; closed, hibernated or a
  create failure hands the role to the next `claude`); sessions left by a stop get a `wakeError` from the
  dictionary; a create failure leaves that session dormant with its reason and the walk continues
- [x] 2.3 `TerminalView.tsx` / `ConversationView.tsx`: on the dormant → running arrival, a view that is active, not
  covered and takes the launch mark focuses its input only when `document.activeElement` is `<body>` or null
- [x] 2.4 `TerminalView.tsx`: a shell writes its snapshot (debounced and at `beforeunload`) only when it has a pty
  **and** this view has not replayed a restored screen that it has not measured since
- [x] 2.5 Update the comments that state "every restored session is dormant" / "cold start starts zero sessions"
  (`sessions.tsx`, `MainStage.tsx`, `TerminalView.tsx` where they say so)

## 3. Copy and agent-facing text

- [x] 3.1 `closeConfirm.consequence`, `consequenceFolder`, `consequenceWindow`, `consequenceWindowFolder`,
  `consequenceRestart`, `consequenceRestartFolder` in `en.json` and `zh-TW.json`: no "when you wake them"; say
  when the sessions start again (spekterm opens again / the window opens again / spekterm starts again with the
  new version); check whether `runCloseConfirm` or an update probe asserts on this text
- [x] 3.2 Two new `wakeError` strings in both dictionaries: not started because the shell environment could not be
  read; not started because the first agent could not keep running
- [x] 3.3 `src/main/handoff-intro.ts`: the "running": false sentence — no process now, hibernated or not yet
  started again after a restart, comes back when the user wakes it or spekterm starts it again, do not wake it;
  its unit test; the introduction stays under the 10,000-character threshold

## 4. Probes

- [x] 4.1 `probe:terminal` `runRestore`: rewrite around the new rule — running sessions have ptys after relaunch
  without a click, no rail item selected; a session hibernated before the quit is dormant with no pty; a session
  left dormant stays dormant across another restart; first display fits a started-at-launch session's pty to the
  terminal; a shell started hidden and never displayed replays the same screen after another restart (no added
  separator). Controls: drop the `spawned` write ⇒ "started without a click" goes red; drop the fitted condition of
  2.4 ⇒ the replay assertion goes red
- [x] 4.2 `probe:terminal` focus section, with the walk held back by a stand-in derived from the profile like the
  other probe stand-ins (not an environment variable): (a) display a not-yet-started session, move focus into the
  side panel, it starts ⇒ focus stays in the panel (control: launch arrival focuses unconditionally ⇒ red); (b)
  display one by keyboard so its Wake button has focus, it starts ⇒ its input has focus (control: drop 2.3 ⇒ red);
  (c) click Wake on one waiting for its turn ⇒ one pty, input focused (no probe mutation separates it: `wake()`
  itself refuses a second start; the walk's `waking` skip is unit-tested in `launch-start.test.ts`);
  (d) a session being started when the user displays it and moves focus to the panel ⇒ focus stays (control:
  `focus()` clears the launch mark ⇒ red)
- [x] 4.3 `probe:terminal`: kill the app while a session runs ⇒ it has a pty after relaunch (extend
  `runHealAndCrash`); reload with one running and one hibernated ⇒ only the running one has a pty
- [x] 4.4 `probe:agent-view` (stub agent) or `probe:terminal`: the canary — seeded `claude` sessions with
  `running: true` and an agent that exits at once ⇒ at most one started, the others dormant, present, with the
  reason (control: no canary ⇒ red); the canary hibernated by the user right after it starts ⇒ the others start;
  seeded entries without the field ⇒ no pty (first launch after upgrading); a seeded `running` entry whose folder
  is in the workspace but whose directory is gone ⇒ dormant with its reason. The environment refusal is carried
  at unit level (1.6) unless a probe can make the resolution fail; record which in the coverage table
- [x] 4.5 Every other section that relaunches, closes the window or reloads with running sessions and then expects
  them dormant or clicks Wake: in `probe:terminal` at least `runMode` (reload ~2802), `runAltScreen` (~3578),
  `runGlobalSession`, `runUnicodeWidth` (~4291), `runHibernate`, `runCloseConfirm`; then grep `clickWake(`,
  `Page.reload`, `quitGracefully` and the relaunch helpers in `probe-agent-view`, `probe-intake`
  (`runHandoffRestored`, lineage), `probe-remote`, `probe-openspec`, `probe-workspace`. Each asserts what now
  happens; a section about the wake itself hibernates first
- [x] 4.6 `probe:intake` / agent-session-control: "A self-close left unread at quit does not act after a restart" —
  after relaunch S is present, running, and no close is offered; the introduction sentence of 3.3 where the probe
  reads the introduction
- [x] 4.7 `scripts/probe-package-mac.mjs` (~699, `shells.length === 0` after reopening the window): assert the
  running session started again; rename its check label; run `probe:package:mac` on the Mac
- [x] 4.8 `scripts/scenario-coverage.test.mjs`: register `restore-running-sessions` in `COVERED_CHANGES`; edit in
  place the existing rows of the rewritten scenarios (`Opening the application starts no session`,
  `冷啟動不因全域項目恆存而喚醒 session`, `Activating the application restores the sessions` with its new
  `probe-package-mac` label, `A self-close left unread at quit does not act after a restart`, `Confirming closes
  the window and ends the sessions`, `Selecting the global item does not start its sessions`,
  `claude 目標的全域 session 續接原對話`, `The introduction explains a not-running relative`); add a row per new
  scenario with carrier, `greenIfAbsent` and `mutation`

## 5. Docs

- [x] 5.1 Website, both languages: `docs/using/terminals-and-sessions.md` (restart, hibernation, closing on macOS),
  `docs/getting-started/install.md` (macOS reopen "restored as dormant"), and each of `first-workspace.md`,
  `index.mdx`, `using/handoffs.md`, `reference/settings.md` where it says sessions are dormant after a restart
- [x] 5.2 `README.md` (~89-91) and `README.zh-TW.md` (~80): macOS reopen no longer "restored as dormant"
- [x] 5.3 `openspec/specs/terminal-sessions/spec.md` Purpose (lines ~14-16, "starts one only when the user explicitly
  wakes it"): restored sessions that were running start again — edited directly, a delta cannot change a Purpose
- [x] 5.4 `CLAUDE.md`: the hibernation line gains that sessions running at close start again at launch (launch
  mark, environment check, canary); `docs/lessons/terminal.md` the extended snapshot guard, and any lesson the
  implementation turns up

## 6. Verify

- [x] 6.1 `npm run typecheck`, `npm run lint`, `npm test`
- [x] 6.2 The probes touched in section 4, each on its own; then `npm run test:e2e`
