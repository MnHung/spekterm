## Why

Since `session-hibernation`, opening the application starts no session at all: every restored session is
dormant until the user wakes it by hand. That rule was made so a keyboard pass over the rail would not start
sessions kept for occasional use — but it also puts the sessions the user was actually working in to sleep.
After every restart the user has to find the sessions that were running and press Wake on each one, although
hibernation (by hand or by the idle policy) already says which sessions should stay asleep.

## What Changes

- **Sessions that had a running process when the application closed start again at the next launch**, without
  being displayed and without taking the rail selection or the user's keyboard focus. A `claude` session resumes
  its conversation and a shell session respawns in its last directory, exactly as an explicit Wake does today.
- **Sessions that were dormant when the application closed stay dormant**: those the user or the idle policy
  hibernated, and restored sessions that were never woken. They still start only on an explicit Wake.
- **Displaying a dormant session still does not start it** — only "opening the application starts no session"
  goes away.
- The same applies whenever a window restores its sessions after its ptys were ended without the sessions
  ending: a renderer reload, and on macOS reopening the window after closing it.
- **A systemic failure is not repeated across every session**: no agent is started when the user's shell
  environment could not be read at launch, and if the first `claude` session started this way cannot keep running,
  the rest stay dormant, say why, and are tried at the next launch.
- A session started while hidden spawns at the default size and is fitted when first displayed, as a session a
  paired device starts; a shell started while hidden does not overwrite its saved screen until it is displayed.
- Whether a session was running is recorded by the main process (a new main-owned field in `sessions.json`).
  A file written before this change has no such record, so **on the first launch after upgrading every
  session is dormant**, as before; from then on the record exists.
- The close-confirmation and restart-to-update dialogs stop saying sessions resume "when you wake them".
- **BREAKING (behavior)**: a restart no longer leaves every session dormant. A hibernate command an agent wrote
  that was left unread at quit no longer "changes nothing": its target comes back running.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `session-persistence`: "Restored sessions are dormant and start only on an explicit wake" becomes "Restored
  sessions that were running start again; the others are dormant and start only on an explicit wake", with the
  focus, canary and size rules of starting again. "Opening the application starts no session" and
  "冷啟動不因全域項目恆存而喚醒 session" are rewritten around sessions that were dormant at close.
- `global-session`: "全域 session 一樣跨重啟存活並重建" stated that restored global sessions are dormant; it now
  follows `session-persistence`, and "Selecting the global item does not start its sessions" is about global
  sessions that were dormant at close.
- `workspace-app-shell`: the close confirmation no longer promises a wake and no longer says the sessions are
  restored as dormant; on macOS, reopening the window restores its sessions as after a restart.
- `session-hibernation`: the introduction no longer says a relative listed as not running is only ever started by
  the user — after a restart, spekterm starts it again.
- `agent-session-control`: the recorded gap "after a restart every session is dormant, so a dropped hibernate
  changes nothing" is restated, and "A self-close left unread at quit does not act after a restart" no longer
  claims the session is dormant afterwards.

Checked and unchanged: `session-hibernation` (its "A hibernated session survives a restart as dormant" is exactly
what this change keeps), `session-lineage` (the relations file is unchanged; only the introduction's wording,
above), `remote-protocol` (a device's quiet wake keeps taking no focus; the launch start uses its own mark),
`terminal-sessions` requirements (no size is derived without a box — its Purpose sentence is edited directly),
`session-wait-indicator` (a session resumed after a restart is already idle). Scenarios whose
precondition is "reopened and woken" keep their wording: their outcome holds for a session that started again
(design Non-Goals).

## Impact

- **Main process**: `src/main/session-store.ts` (the `running` entry field: type, `replace()`,
  `parseSessionEntry`, `update()`); a new `src/main/session-running.ts` with the record rules;
  `src/main/ipc/terminal.ts` (sink `spawned` / hibernated exit, the `hibernate` handler, the restore answer, the
  automatic wake's environment check, `releaseRenderer`'s flush order); `src/main/user-env.ts` (failed vs skipped);
  `src/main/handoff-intro.ts` (one sentence).
- **Renderer**: `sessions.tsx` (the walk, the launch mark, the canary), `TerminalView.tsx` / `ConversationView.tsx`
  (the launch arrival's focus rule; the shell snapshot guard); preload types for the restore answer.
- **Copy**: six `closeConfirm.consequence*` strings and two new not-started reasons in `en.json` and `zh-TW.json`.
- **Probes**: the sections that relaunch or reload with running sessions and then expect them dormant or click
  Wake (`probe:terminal` and others, listed in tasks), `probe-package-mac.mjs`'s reopen section; the scenario
  coverage table's existing rows are edited in place, new rows added.
- **Docs**: the website's session and install pages in both languages, `README.md` / `README.zh-TW.md` (macOS
  reopen), `CLAUDE.md`'s hibernation line, `docs/lessons/terminal.md`, the `terminal-sessions` Purpose.
