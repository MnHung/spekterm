## 1. Measurements on the Mac (before the code they decide — design A2)

- [x] 1.1 With the maintainer, grant the one-time macOS permissions the acceptance needs: Accessibility,
  and Automation for System Events, for the program the SSH session runs. Verify: `osascript` reading
  Finder's menu bar items returns names instead of timing out with `-1712`.
  - 2026-10-12. Accessibility is needed for **both** `/usr/libexec/sshd-keygen-wrapper` and `/usr/bin/osascript`:
    with only the first, `osascript` failed with "osascript is not allowed assistive access" (-1719).
    Automation for System Events was granted at its prompt.
- [x] 1.2 Copy the working tree to the Mac's clone (`rsync`, design Migration Plan). Build an unsigned
  trial bundle there: `npm run build && node scripts/package-mac.mjs -- --dir -c.mac.identity=null`. Measure with
  a temporary, uncommitted instrumentation in `src/main/index.ts`: an Edit menu of roles, and a log line
  per `close` / `before-quit`. Record each result under this task:
  - whether `Cmd+V` in the terminal pastes twice;
  - whether macOS adds its own items (Start Dictation, Emoji & Symbols) to a menu named Edit;
  - whether a role item's `label` override shows on macOS;
  - the event order of `osascript -e 'tell application id "com.spekterm.app" to quit'`;
  - the event order of `kill -TERM`.

  Remove the instrumentation afterwards. **If the quit Apple event emits `close` first, stop and ask the
  maintainer before section 3.** Logout and shutdown would then be held by the sessions dialog, which is a
  requirement-level trade-off, not a scenario edit.
  - 2026-10-08, measured remotely: an instrumented, unsigned trial bundle, launched with `open` and its own
    throwaway profile, built in a scratch copy on the Mac and not in the repo. `kill -TERM` gives
    `before-quit` → `close` → `closed`, and the app exits by itself, the same order as on Linux.
  - The rest needs someone at the Mac, and waits for 1.1: the paste, the Edit-menu items, the label
    override, and the quit Apple event (the Automation prompt has to be answered on its screen).
  - 2026-10-12, measured with the real menu and UI scripting, rather than temporary instrumentation (the
    probe's sections are the measurement):
    - **`Cmd+V` in the terminal pastes twice** once an Edit menu exists: the pasted line ran as one doubled
      command and wrote `P%sP`. Hence 3.6.
    - **macOS adds two items to a menu named Edit, in the system's language**: 「啟動聽寫⋯」 and
      「表情符號和其他符號」 on the Traditional Chinese build Mac. The probe recognises them as the system's.
    - **Role items honour the `label` override**: the Edit menu showed the dictionary's labels in both
      languages.
    - **The quit Apple event behaves as `before-quit` first**: with a running session it asked nothing
      and the app exited; with an unsaved file it asked about the file, and "Don't Save" finished the
      quit. No requirement-level decision was needed.
    - **Found on the way: closing a window that has a sheet ends the sheet** (Electron, on macOS). `Cmd+Q`
      during the open close dialog made the dialog vanish, and nothing quit. `closeForQuit` now only
      upgrades the open question's intent (`close-guard.ts`, with a unit check that no second close reaches
      the window).
- [x] 1.3 On the Mac, with a throwaway script run by `electron` that prints `app.getPath('userData')` with
  and without `XDG_CONFIG_HOME`: confirm that the variable is ignored on macOS. This avoids `npm run dev`,
  which would write into the real data directory. Record under this task.
  - 2026-10-08, Electron 43.5.0 on macOS 13.7.8, with a script whose package declares `productName:
    Spekterm`: without the variable and with `XDG_CONFIG_HOME=/tmp/spk/xdg`, both print
    `~/Library/Application Support/Spekterm`. The variable is ignored, as the spec gap says.

## 2. Packaging configuration and release scripts

- [x] 2.1 `package.json`:
  - add `build.mac` (dmg, `arm64`, `identity: "-"`, `hardenedRuntime: false`, category, icon,
    `extraResources` for the two licence files) and `build.dmg`;
  - move the top-level `extraFiles` into `build.linux.extraFiles`;
  - add `build.afterPack`, the `dist:mac` script (release check → `npm ci` → build → `package-mac` →
    prune), and `@electron/get` as a devDependency pinned to the version installed under `electron`.

  Verify: `npm ci` succeeds. `npm ls @electron/get --all` shows `electron`'s copy as `deduped` against the
  root's 5.x; `app-builder-lib`'s 3.x copy stays separate, as expected.
- [x] 2.2 `scripts/release-check.mjs`. It takes the repo root from `argv`, and the platform from an argument
  or option so that tests can run it as macOS. It uses `LC_ALL=C`, and imports `VERSION_FILES` from
  `release-bump.mjs`. It refuses:
  - a platform other than macOS;
  - a dirty tree, untracked files included;
  - a subject that is not `chore(release): <declared version>`;
  - a release commit that changes files other than the version files;
  - a clone shallower than two commits.

  Each refusal states the fix. Verify with `scripts/release-check.test.mjs` on git fixtures, run as macOS:
  - **refused, each by its reason's text, not just the exit code**: a later commit, an untracked file, a
    wrong-version subject, an extra file in the release commit, a shallow clone;
  - **passes**: a detached release commit;
  - **refused as the real CLI on Linux**, with a message naming macOS.
- [x] 2.3 `scripts/package-mac.mjs`: the real `@electron/get` `downloadArtifact`, with `checksums` from
  `node_modules/electron/checksums.json` and the mirror via `ELECTRON_MIRROR`, then
  `electron-builder --mac -c.electronDist=<zip>`. Verify with `scripts/package-mac.test.mjs`, calling the
  real `downloadArtifact` with an injected `downloader` and a temporary `cacheRoot`:
  - a fixture zip whose hash is in the map passes;
  - an altered map entry throws;
  - the map is read for the installed `electron` version.
- [x] 2.4 `scripts/after-pack.cjs`, macOS only:
  - delete `Contents/Resources/default_app.asar` (tolerating its absence);
  - copy the Electron distribution's `LICENSE` to `Contents/Resources/LICENSE.electron.txt`, and its
    `LICENSES.chromium.html`.

  On Linux it does nothing. Verify with `scripts/after-pack.test.mjs` on fixture output directories for
  both platforms.
- [x] 2.5 `scripts/prune-release.mjs`: AppImages and dmgs are counted separately, two of each kept by
  version order, and a dmg's `.blockmap` goes with it. Verify with `scripts/prune-release.test.mjs`: three
  of each kind, dmg names across a ten boundary (`0.1.9` / `0.1.10`), and an unrelated file kept.
- [x] 2.6 `scripts/packaging-config.test.mjs`, with a control for each new check (remove or alter the item,
  see red):
  - the macOS target fields;
  - no top-level `extraFiles` and no `build.mac.extraFiles`;
  - `dist:mac` ordering: release check before the build, `package-mac` and no direct `electron-builder`
    call, prune last, and no `release-bump`;
  - `artifactName`, if set under `build.mac` or `build.dmg`, contains the version;
  - `@electron/get`'s declared version equals the copy that `electron` resolves (resolved from
    `node_modules/electron`, not the hoisted copy).
- [x] 2.7 `scripts/site-boundary.test.mjs` reads every `build.{linux,mac,win}.{files,extraFiles,extraResources}`.
  Verify its new control: a `site/**` entry in `build.mac.extraResources` makes it red.
- [x] 2.8 `npm run typecheck`, `npm run lint`, `npm test` green.
  - 1803 unit tests pass. Lint needed a block for `scripts/**/*.cjs` (CommonJS, Node globals): the
    `afterPack` hook is the first CommonJS script.
  - Controls run by hand, each red, then restored:
    - `release-check`: the changed-files check removed, and the dirty-tree check removed;
    - `package-mac`: `unsafelyDisableChecksums` passed instead of `checksums`.
  - `VERSION_FILES` and the release subject moved to `scripts/lib/release-files.mjs`, which `release-bump`
    and `release-check` share.

## 3. Window, menu, and quit (main process and renderer)

- [x] 3.1 The menu (design W1):
  - a template builder in a module that does not import `electron`: macOS gets the minimal template, with
    labels from the dictionaries, a custom Quit item with `Cmd+Q`, and no Window menu or `Cmd+W`;
    Linux and Windows get `null`;
  - `src/main/index.ts` sets the menu once in `whenReady`, not in `createWindow`;
  - `src/main/ipc/settings.ts`'s `setLanguage` rebuilds it;
  - `en.json` / `zh-TW.json` gain the labels.

  Verify:
  - a unit test of the builder for both platforms and both languages;
  - `probe:shell`'s Alt check green;
  - `dictionary-completeness`, `i18n-key-safety`, and `copy-language` green.
  - `src/main/app-menu.ts` (no Electron import) and `app-menu.test.ts`: Linux and Windows `null`; macOS two
    menus with exactly the listed roles, Quit a custom `Command+Q` item, nothing on `+W`, and labels from
    the dictionaries in the current language (checked in `zh-TW`).
  - The menu is set in `whenReady` and rebuilt on i18next's `languageChanged`. That covers the startup
    language and the Settings change from one place, so `ipc/settings.ts` needs no callback.
  - **Correction**: the task's verification says "`probe:shell`'s Alt check green". `probe:shell` has no
    Alt check; it passed 29/29, but none of its checks presses Alt. The Linux "no menu" scenario is carried
    by the unit test of the template only, and the coverage table says so.
- [x] 3.2 `src/main/close-guard.ts` (design W2):
  - each close decision carries an intent (`close` / `quit`);
  - `before-quit` first, or the Quit item, sets `quit`;
  - a quit request during an open dialog upgrades the intent;
  - cancel discards it;
  - `onClosed('quit')` calls `app.quit()`.

  Verify with unit tests for each path: nothing to ask, asked and confirmed, unsaved changes answered on an
  OS quit, a quit during the open dialog then close, and a quit during the open dialog then cancel followed
  by a confirmed plain close, which does not quit. The existing close-guard and quit tests stay green.
  - `GuardedWindow.closeForQuit()` and `CloseGuardDeps.onQuitClose`. `index.ts` finishes the quit with
    `app.quit()` on the window's `closed`.
  - Seven new cases in `close-guard.test.ts`. Controls, each red, then restored: without the upgrade
    during an open prompt, and without `onQuitClose` on the nothing-to-ask path.
  - The guard also tells the prompt whether the close ends the application. This is W4's second line,
    and on macOS it changes the buttons too: Close Window, Save All and Close, Close Without Saving.
- [x] 3.3 Window lifecycle (design W3), its logic in modules that do not import `electron`:
  - `ensureWindow()` replaces `bringToFront()` at the notification click, open inbox, and reveal-brief
    sites;
  - a per-window cleanup that `destroyed` runs, including `disposeConversationFor`;
  - a new `app:rendererReady` IPC in the preload allow-list, sent by the renderer once its intake and
    handoff listeners are mounted.

  Verify:
  - a unit test of `ensureWindow`: it creates the window and acts only after ready;
  - a unit test that the cleanup releases the conversation tracking;
  - `probe:shell`'s allow-list assertion updated and green.
  - `src/main/window-presence.ts` and its test: create when there is no window, wait for the renderer's
    ready signal, a renderer that went away must signal again, and a timeout so that a renderer that
    never signals cannot hold an action forever.
  - `index.ts`: the notification click goes through `presence.ensure()`; `activate` reopens through the
    same window dependencies.
  - `AppShell` sends `app.rendererReady()` from its own effect. A parent's effect runs after its
    children's, so the inbox, brief, and focus listeners are mounted by then.
  - `ipc/terminal.ts`: the destroyed and reload paths now share one `releaseRenderer` body, which
    includes `disposeConversationFor`. **No unit test for this one**: the module imports `electron`. The
    shared body is what makes the two paths unable to differ again.
- [x] 3.4 Audit the main-process state keyed by window or `webContents.id`: maps, watchers, broadcasters,
  `quitState`, and the close-guard state. Release anything found in the per-window cleanup. Record the
  audit list under this task.
  - Audit, 2026-10-08. Each entry is released on `destroyed` (and on `did-navigate` where it matters):
    - `ipc/folders` branchServices, `ipc/panel` pending, `ipc/openspec` services, `ipc/fs` services;
    - `ipc/terminal` services, owners, statusServices, and pending (flushed);
    - `hibernation` displayed (deleted on `null`), `dirty-state`;
    - `guardedWindows`, and presence readiness.
  - The intake and Slack sender sets prune destroyed senders. `revealHandoffBrief` sends to the live
    windows.
  - The only leak found was the conversation tracking, fixed in 3.3.
- [x] 3.5 `src/main/terminal.ts`: the `ptyCwdReadable` predicate, used by `readPtyCwd`. Dictionaries: the
  close dialog's consequence text, split by where shells restart and by what is closing (design W4).
  Verify with a unit test that the text chosen on a platform without a readable cwd says "folder", and on
  macOS "window". `dictionary-completeness` stays green.
  - `src/main/pty-cwd.ts` (`ptyCwdReadable`, `readPtyCwd`), moved out of `terminal.ts`, with tests.
  - Dictionaries: `consequenceFolder`, `consequenceWindow`, and `consequenceWindowFolder`, and the window
    button labels, in both languages. `close-prompt.test.ts` covers the folder and window wording.
- [x] 3.6 If 1.2 measured a double paste: in `src/renderer/src/shell/terminal/xterm.ts`, the custom key
  handler calls `preventDefault()` for the keys it handles itself (`Cmd+V`, and `Cmd+C` with a selection).
  If not, record that here and leave the code.
  - Measured double (1.2). `xterm.ts` calls `preventDefault()` for the keys the custom handler takes. Red
    before the fix (`P%sP`), green after (`P`).
- [x] 3.7 `src/main/user-env.ts`: correct the comment that says macOS's `env` lacks `-0`, citing the
  measurement in design Context.
- [x] 3.8 `npm run typecheck`, `npm run lint`, `npm test` green.

## 4. Acceptance

- [x] 4.1 `scripts/probe-package.mjs` (Linux): assert `LICENSE.electron.txt` and `LICENSES.chromium.html`
  at the AppImage root. Run it without bumping: `npm run build && npx electron-builder --linux`, then
  `PROBE_PACKAGE_APPIMAGE=<path> node scripts/run-probe.mjs package`. Confirm green, including the
  existing licence assertions after the move to `build.linux.extraFiles`.
  - 2026-10-08, AppImage built with `npx electron-builder --linux` from the working tree: 16/17. The new
    check ("the AppImage root carries Electron's and Chromium's licence texts") and every existing licence
    check pass after the move to `build.linux.extraFiles`.
  - The one red, "打包指令自身遞增版本並提交", is the expected cost of not bumping: HEAD is not a release
    commit. It turns green on the release run (6.1).
  - Note: this replaced `release/Spekterm-0.2.3.AppImage` with a build of the working tree. The published
    0.2.3 on GitHub is untouched.
- [x] 4.2 `scripts/probe-package-mac.mjs`, run as `npm run probe:package:mac`, which is `node` directly,
  not `run-probe.mjs`:
  - ports in `scripts/lib/ports.mjs`; left out of `run-probes.mjs`;
  - `PROBE_PACKAGE_MAC_DMG` to point at any dmg or `.app`; the default is the declared version's dmg;
  - a pid-based `quitAndWait` in `scripts/lib/quit.mjs`; `preflight.mjs`'s port-holder lookup checked on
    macOS;
  - a pre-flight for macOS, the bundle present, the UI-scripting and Automation permissions, and an
    unlocked logged-in screen;
  - the sections of design A1 steps 1–9, with:
    - real sheets read and clicked through UI scripting;
    - `Cmd+Q` pressed with focus in the terminal and in the editor;
    - the agent section last;
    - the `LSMinimumSystemVersion` and top-of-`Contents/` checks;
    - every section that needs a permission declaring it as a dependency.

  Verify: `npm test` green (ports, globs, `quit-source`).
  - Written. Run on the Mac (2026-10-08) against a trial dmg built from the rsynced tree: 13/24.
    - Green: the static checks (seal, placeholder, licences, top of `Contents/`, `LSMinimumSystemVersion`),
      the minimal-environment control, renderer, CSP, pty + command, `claude` resolved in a session, and
      the agent session.
    - Red as expected: the build identity (a trial build reports uncommitted changes).
    - Not run: the ten UI-scripting sections (1.1 not granted).
  - Two probe bugs found and fixed on the way:
    - the "new shell" matched the app's own `zsh -i -l -c …` environment query, so shells with `-c` no
      longer count;
    - a second launch on the same port drove the first instance, so `launch()` now quits earlier
      instances first.
  - 2026-10-12, the trial dmg from the current tree: **32/33**. The one red is the build identity, which a
    trial build reports as dirty by design; it is green only on the release run (6.2).
- [x] 4.3 On the Mac, against bundles built from the rsynced tree, run the probe through the override and
  record each result under this task:
  - the fixed build passes every section;
  - an unsealed bundle (`identity: null`) fails the signature section;
  - a bundle without the `afterPack` hook fails the `default_app.asar` and licence sections;
  - a launch with the SSH environment makes the minimal-environment control red;
  - the build without 3.1–3.3 fails the menu, `Cmd+Q`, and reopen sections.
  - Run remotely, 2026-10-08, against dmgs from `package-mac.mjs` with overrides:
    - unsealed (`-c.mac.identity=null`): the signature check is red ("code has no resources but signature
      indicates they must be present"), and the rest is unchanged;
    - without the hook (`-c.afterPack=<a no-op hook>`): "no placeholder application ships" and the
      licence check are red (missing `LICENSE.electron.txt`, `LICENSES.chromium.html`); the seal is
      still valid;
    - environment: with `~/.local/bin` on `PATH`, `command -v claude` prints a path, which turns the
      minimal-environment check red.
  - Still to run at the Mac: the fixed build's UI sections, and the build without 3.1–3.3.
  - The build without 3.1–3.3: a control dmg from the commit before this change (`3df0a7c`, unsigned,
    built in a temporary worktree on the Mac): **14/30**. Red as required:
    - the menu (it still carried Electron's default menu, with Services, a Window menu and `Cmd+W`,
      despite `setApplicationMenu(null)` in `createWindow`), `Cmd+W`, and the language switch;
    - `Cmd+Q` asks: after tightening, see below;
    - the window wording, the window keeping the app, the reopen, and the second window's menu;
    - `Cmd+Q` during the open dialog, the OS quit finishing after "Don't Save", and the terminal paste.
  - **The control exposed a false green.** "`Cmd+Q` asks" checked only for a Cancel button and passed on
    the old build, whose `Cmd+Q` asked about the unsaved file alone. It now requires the question that
    names the running session, and is red on the old build.
  - Green on the old build as well, and marked so in the coverage table: text-field copy and paste and the
    editor paste (Electron's default Edit menu), `Cmd+Q` with nothing to ask, Quit with no window, and the
    OS quit with a running session (the existing before-quit rule).
- [x] 4.4 With the Electron cache emptied on the Mac and `ELECTRON_MIRROR` set, run the install and
  `package-mac` once. Record that the archive came from the mirror and passed the pinned checksum. This is
  the carrier of "A mirror delivers a verified archive".
  - 2026-10-08, on the Mac. `HOME` pointed at an empty directory, so `@electron/get`'s cache was empty;
    `electron_config_cache` is read by `electron`'s own install script, not by `@electron/get`. With
    `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`, the 123 MB archive came from the mirror in
    about 10 s, into the fresh cache. `[package-mac] … matches the pinned checksum`, and the build
    continued.
- [x] 4.5 `scripts/scenario-coverage.test.mjs`: register `macos-dmg-packaging` in `COVERED_CHANGES`.
  - **A scenario whose title already has a row** (about 30, including the MODIFIED copies): update that
    row's carrier, `greenIfAbsent`, `mutation`, and note. For example, the mutation that removes
    `build.extraFiles` becomes `build.linux.extraFiles`, and "Confirming closes the window…" becomes
    Linux-only.
  - **A new title** gets a new row.
  - Labels are found in the probes and tests, not from memory, and the dogfood gaps are marked as such.

  Verify: `npm test` green.

  - 86 rows for the change. The three level scenarios of `build-identity` already had rows and are
    unchanged.
  - Three carriers do not exist: the mirror run (a manual run, 4.4), the macOS limitations prose, and two
    status-bar scenarios that had no carrier before this change.
  - The Linux Alt-menu row is honest about being unit-level only.
  - New guard, `packaging-config.test.mjs`: the macOS install facts in both READMEs and both install
    pages, and the macOS build facts in both READMEs, with a control.
## 5. Documentation

- [x] 5.1 Open GitHub issues for the macOS gaps this change documents but does not fix, so that the docs and
  spec gaps can link them:
  - a pty's working directory on macOS (shell restore and the status bar);
  - automatic hibernation of shells on macOS;
  - the monospace font list on macOS;
  - `npm run dev` data isolation on macOS;
  - `Ctrl+↑/↓` vs Mission Control;
  - `node_modules` drift on `dist:linux`;
  - building on CI.

  Close issue #63 (the macOS build) with a reference to this change once 6.3 has published the dmg.
  - Opened 2026-10-12: #67 (a pty's working directory), #68 (idle hibernation), #69 (font list), #70 (`npm
    run dev` data isolation), #71 (`Ctrl+↑/↓`), #72 (`node_modules` drift on `dist:linux`), #73 (building on
    CI). The docs gain the links in the release commit that turns "in testing" back into "available"
    (6.3), so that the website is redeployed once.
  - #63 is closed at 6.3. Intel (x64), which it also named, stays out of scope (proposal).
- [x] 5.2 `README.md` and `README.zh-TW.md`, kept in sync:
  - the platform status (Linux, and macOS on Apple Silicon);
  - the macOS install: minimum version, the first-launch allow step for 13 and for 15 or later, the
    damaged-app escape, why privacy prompts name spekterm, that updates may ask again, the data location,
    and the limitations with their issue links;
  - building for macOS: a release commit, `dist:mac`, `ELECTRON_MIRROR` (which applies to `npm ci` too),
    and the trial-build command marked as not a release.

  Verify: `packaging-config`'s README checks, and the "Nothing says" phrases searched over the READMEs.
  - Written by a delegated agent, 2026-10-08; reviewed here. `site-boundary.test.mjs` follows the plan's
    renamed `forbiddenPhrases` (it read `linuxOnlyPhrases`) and now normalises whitespace too.
- [x] 5.3 Website, both languages (`site/src/content/docs/` and `zh-tw/`), wherever it says something that
  is not true on macOS:
  - landing page: platform status, and a download button that names no single format;
  - documentation home: platform status, and the "Download the AppImage" card;
  - install: a macOS section;
  - first workspace;
  - terminals and sessions: closing the window, where shells restart, idle hibernation, the status bar's
    directory;
  - settings: the font list;
  - keyboard shortcuts: the `Ctrl+↑/↓` macOS note;
  - inbox and Slack, and data and network: the macOS data path, and that the app keeps running (and
    polling) with its window closed;
  - FAQ: the macOS answer;
  - troubleshooting: damaged app, prompts, permissions after update.

  `site/src/i18n/*.json` hero strings; `site/src/content-plan.json` and `site/scripts/check-content.mjs`
  get the new phrases and the forbidden ones from the `project-website` scenarios. Verify:
  `(cd site && npm ci && npm run build)` green, and the forbidden phrases searched over `site/dist` return
  nothing.
  - Pages changed in both languages:
    - landing (button "Download", platform status), docs home, install (a macOS section);
    - first workspace, terminals and sessions, settings, keyboard shortcuts;
    - inbox and Slack, data and network, FAQ, troubleshooting.
  - `check-content.mjs` bans the scenario phrases (case- and whitespace-insensitive) and a one-format
    download link, with self-test cases.
  - `(cd site && npm ci && npm run build)` passed. A search of `site/dist` and the READMEs for the banned
    phrases finds 0, against 2 on the committed READMEs.
  - Unverified: the Traditional Chinese macOS label for "Open Anyway" (written as 「強制打開」 with the
    English name beside it).
- [x] 5.4 `openspec/specs/desktop-packaging/spec.md` Purpose: it describes the Linux and macOS artifacts.
  Purpose is not carried by deltas, so it is edited directly.
- [x] 5.5 `docs/PRD.md`: §11 Phase 6 (macOS on Apple Silicon, ad-hoc, delivered; what remains: Developer ID,
  notarization, auto-update, Intel, Windows, CI build), and the other places that say macOS is not done
  (the status near the top, and the platform notes further down).
- [x] 5.6 `CLAUDE.md`:
  - the commands: `dist:mac` and `probe:package:mac`;
  - "現況": macOS is no longer "尚未開始";
  - the native menu paragraph: the macOS menu and its reason, replacing "macOS 未實測";
  - the measured macOS caveats (quit order, `open` passing the environment, `ps -E`, privacy prompt
    attribution), each in its section or in `docs/lessons/` with a trigger row.

  Verify: `public-hygiene` and `naming` tests green.

  - New `docs/lessons/macos.md`: 15 measured facts plus the open measurements, with a trigger row in
    CLAUDE.md.
## 6. Release and dogfood (each step leaving the machine waits for the maintainer — design Migration Plan)

- [x] 6.1 After the maintainer has tried the rsynced build on the Mac: commit everything except `site/`,
  then run `dist:linux`. Ask before pushing to master.
  - 2026-10-12. The maintainer had tried the build. `npm run probe:package` bumped to 0.2.4
    (`919f172 chore(release): 0.2.4`) and passed 17/17, with a clean build identity. Pushed. The code
    and the site had already gone out with `a164f26` before this step (see 6.3).
- [x] 6.2 On the Mac: `git pull`, `npm run dist:mac`, `npm run probe:package:mac`. Every section is green;
  "not run" is not acceptable for this run.
  - 2026-10-12, on the Mac. It had just been upgraded from macOS 13.7 to **macOS 27.0.1**, which also gave it
    a new tailscale node. `dist:mac` accepted the release commit (`0.2.4 — release commit 919f172,
    clean`), the archive matched the pinned checksum, and it built `Spekterm-0.2.4-arm64.dmg`.
  - `probe:package:mac`: **33/33**, the build identity included. On the way to that:
    - `ps` showed the app under `/private/var/…` while the probe compared against `/var/…`, so it now
      compares both;
    - macOS 27 adds 「書寫工具」 (Writing Tools) to the Edit menu, now recognised as the system's;
    - on the freshly updated, loaded Mac the pasted text arrived after the Enter, so the probe now
      re-sends Enter until the line runs (a doubled paste still shows as `P%sP`).
  - The maintainer's own Spekterm was running on the Mac. The probe now presses keys only when the app
    under test is frontmost, and sends the quit Apple event to its pid (`NSRunningApplication`), never by
    bundle path.
- [x] 6.3 Ask before uploading the AppImage and the dmg to the GitHub release. Then commit the `site/`
  changes, and ask before pushing them (the push deploys the website).
  - The website and the READMEs went out early (commit a164f26) and now say the macOS build is "in
    testing". At release, turn that back into "available": the README status, requirements and macOS
    install note; the site's `landing.platforms` / `landing.downloadNote`, the docs index, the install
    page (its intro, requirements and "In testing" note) and the FAQ, in both languages. In the same
    commit, link #67–#71 from the macOS limitations (install page, both READMEs).
  - Release `v0.2.4`: created as a draft at `919f172` with the AppImage, the dmg uploaded from the Mac, both
    digests checked against the local SHA-256 (also listed in the notes), then published as latest.
  - The wording turned back to "available", with the issue links and "tested on macOS 13 and 27", in the
    commit pushed after the release.
  - #63 is closed.
