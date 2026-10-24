## 1. Measurements on a real AppImage (before the code they decide — design U4)

**Isolation for every measurement in this section**: build and run in a scratch copy outside the repo, with
`XDG_CONFIG_HOME` and `XDG_CACHE_HOME` pointed at scratch directories (environment variables survive a relaunch;
`--user-data-dir` does not, and `args: []` would start the relaunched build on the maintainer's real profile and
updater cache). The instrumentation never enters the repo.

- [x] 1.1 Build two throwaway AppImages (versions 9.9.1 and 9.9.2, `--publish never`). 9.9.1 carries a temporary
  instrumentation: on a key press it copies 9.9.2 next to `$APPIMAGE` and renames it over `$APPIMAGE` (U4 steps
  3–4), calls `app.relaunch({ execPath: $APPIMAGE, args: [] })` from `will-quit`, and quits; every build logs
  `APPIMAGE` / `APPDIR` / `argv` / its version at startup to a scratch file. Run 9.9.1 from a versionless file name.
  Record under this task: whether 9.9.1 kept running normally until its exit after the rename; whether the relaunch
  happened, exactly once, after 9.9.1 exited; whether 9.9.2 started normally with `args: []` (sandbox flag added by
  `AppRun`). **If the relaunch did not happen, implement and measure the detached-shell fallback of U4 the same way,
  and record which one 4.3 uses.**
  - 2026-10-21, Electron 43.5.0, electron-builder 26.15.7, two scratch builds under Xvfb with scratch
    `XDG_CONFIG_HOME` / `XDG_CACHE_HOME`, from a versionless `Spekterm.AppImage`:
    - **Renaming over the running AppImage is harmless**: 9.9.1 logged after the rename and quit normally
      (`before-quit` → `close` → `will-quit` → `quit` exit 0); the file afterwards is byte-identical to 9.9.2.
    - **`app.relaunch` never starts anything inside an AppImage**: called from `will-quit`, nothing started
      within 60 s; called **before** `app.quit()` (a control), nothing either. So the relaunch is not a matter of
      timing — the relauncher does not survive the image. **4.3 uses the detached-shell fallback.**
    - **The fallback works**: `/bin/sh -c 'while kill -0 "$1"…; exec "$2"'`, spawned detached in `will-quit`,
      started 9.9.2 1.7 s after 9.9.1's `quit`, exactly once, under the shell's pid, reparented to the session
      manager. Its `APPDIR` was a new mount (`/tmp/.mount_…` different from 9.9.1's) and `APPIMAGE` / `ARGV0` the
      same path: the runtime sets them for the image it starts, inherited or not. `exec` with no arguments
      started it normally (`AppRun` decides the sandbox flag).
- [x] 1.2 With 9.9.1 running, send it `SIGTERM`: record the event order (`before-quit` / `close` / `will-quit` /
  `quit`) and the `quit` exit code. Confirms that the quit origin of U4 tells a signal from a closed window.
  - 2026-10-21: `SIGTERM` to the main process gives `before-quit` → `close` → `will-quit` → `quit` with **exit
    code 0** — the same exit code as a closed window, so `electron-updater`'s exit-code test cannot tell them
    apart; the event order can (`before-quit` before `close`), as the close guard already does.
- [x] 1.3 Against a local `generic` feed with `electron-updater` (the version to be added in 2.1), record the error
  codes for: no `latest-linux.yml`; the network unreachable; a wrong `sha512`; and that a cached download is
  re-hashed and reported as downloaded on the next check after a restart. These decide U3's mapping.
  - 2026-10-21, `electron-updater` 6.8.9 in an unpackaged Electron with `forceDevUpdateConfig` and a generic
    feed on `127.0.0.1`:
    - no `latest-linux.yml` (404): `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`;
    - connection refused: **no `code`**, message `net::ERR_CONNECTION_REFUSED` (Chromium's `net::ERR_*` names);
    - wrong `sha512`: `ERR_CHECKSUM_MISMATCH`, from `downloadUpdate()` after a full download (differential
      download needs the old AppImage's embedded block map and a server with `Accept-Ranges`; it falls back);
    - a second run finds the cached file ("already been downloaded"), emits `update-downloaded` with the same
      path and downloads nothing.
    - **Every failure arrives twice**: as an `error` event and as the rejection of the promise. The adapter
      reports each failure to the coordinator once.

## 2. Dependency and packaging

- [x] 2.1 Add `electron-updater` (exact version) to `dependencies`. Verify: `npm ls electron-updater
  builder-util-runtime --all` shows one `builder-util-runtime` deduped against electron-builder's; `npm run build`
  succeeds.
- [x] 2.2 Add `--publish never` to `dist:linux`'s `electron-builder` call and to `scripts/package-mac.mjs`; extend
  `scripts/packaging-config.test.mjs` to assert both. Verify: the test fails with either flag removed.

## 3. Coordinator, backends, state

- [x] 3.1 `src/main/update-version.ts`: parse `x.y.z` / `vx.y.z` (else `null`), compare numerically, build the
  release page URL from a version. Unit tests including `1.10.0 > 1.9.9`, the `v` prefix, junk and pre-release tags.
- [x] 3.2 `src/main/update-state.ts`: `update-state.json` (`notifiedVersion`, `lastCheckedAt`, `installOutcome`),
  written first then assigned (synchronously, for `will-quit`), unreadable → empty. Unit tests including a failed write keeping the previous value
  in memory.
- [x] 3.3 `src/main/update-coordinator.ts` (no Electron, no network import): the states of U1; the first-check
  delay after the **first** restore-gate opening only; the 6 h interval; the resume rule; skip while busy; **no
  check while ready** (scheduled or "Check now"); download only after the version passes U2; the switch semantics of
  U5; once-per-version notification; the failure mapping from 1.3 (channel file missing → up to date). Unit tests
  with a fake clock and fake backends.
- [x] 3.4 `src/main/update-installer.ts` (the only importer of `electron-updater`): the backend-choice predicate
  (packaged or probe feed; Linux; absolute existing regular `APPIMAGE`; writable directory; `APPDIR` not
  `appimage_extracted_*`) as a pure function with a unit test per failing condition; the adapter with
  `autoDownload`, `autoInstallOnAppQuit` and `autoRunAppAfterInstall` all `false`, `allowDowngrade` and
  `allowPrerelease` `false`, the logger, the event mapping, and the downloaded file's path from `update-downloaded`.
  A unit test (source scan in the test) that the module never references `install(` or `quitAndInstall(`.
- [x] 3.5 `src/main/update-release-check.ts`: `net.fetch` of the releases API with the timeout and headers of U1;
  only `tag_name` is read (U2). Unit tests with an injected fetch: a good answer, a malformed tag, a non-GitHub
  `html_url` (ignored), 403, timeout.
- [x] 3.6 The probe feed override (U9): `<userData>/update-feed.json` read only when `!app.isPackaged`, naming the
  feed URL, the release-API URL, the first-check delay and the `app-update.yml` path (`updateConfigPath`,
  `forceDevUpdateConfig`). Unit tests: the gate reads `isPackaged`; a packaged run never opens the file.
- [x] 3.7 Network allow-list: the file-scoped entries for the updater module and the release check in
  `scripts/network-surface.test.mjs` (and fix its header's `.mdx` → `.md`). Verify: `npm test` passes, and fails
  with each new entry removed.

## 4. Restart and install

- [x] 4.1 `close-prompt.ts`: a `restart` intent (title, confirm label, Cancel the default, the same session list and
  restart-location line); strings in `en.json` and `zh-TW.json`. Unit tests for the prompt's keys, roles and default.
- [x] 4.2 `close-guard.ts`: `closeForRestart()` / `onRestartClose`, built like `closeForQuit()`, and the quit
  origin (`user` when a close went ahead without `quitting`, `restart`, `signal` when `before-quit` came first).
  The origin is recorded where the guard allows a close (nothing to ask, and the answer "close"); the first record
  wins. Unit tests in `close-guard.test.ts` with the fake window: cancel discards the intent, one question at a time,
  a restart requested while a close question is open, nothing to ask closes at once **and records `user`**, a signal
  quit's origin, and **a `before-quit` after a `user` record does not turn it into `signal`**.
- [x] 4.3 `src/main/update-install.ts`: U4's sequence with injected `fs` and `app` — the startup identity of
  `$APPIMAGE`, the preconditions, the destination rule, stage in the destination directory + the old file's mode +
  `fsync` + `rename`, all synchronous, the downloaded copy deleted after success, a leftover staging file removed at
  startup, unlink of a versioned old file only after the rename, the relaunch target (or the fallback chosen in
  1.1), the outcome written to update state before the relaunch. Unit tests: versionless and versioned
  destinations; a missing download → nothing touched, outcome recorded; a replaced `$APPIMAGE` → not overwritten; a
  failing copy → staging removed, `$APPIMAGE` byte-identical, old version relaunched (restart) or nothing (quit); a
  `signal` origin installs nothing; a `user` origin with the switch off installs nothing; a `user` origin never
  relaunches.
- [x] 4.4 Wire it in `src/main/index.ts`: create the coordinator after the preferences store, start it on the
  first restore-gate opening, clear its timer and run the one-shot install in `will-quit`, register the restart
  path. Verify: `npm run typecheck` and `npm test` pass.

## 5. Preferences, IPC, notification, Settings

- [x] 5.1 `preferences-store.ts`: the `updates` group with `autoCheck` (on = field deleted), its own field table
  bound with `satisfies`, projected through `projectPreferences`, no `PREFERENCES_VERSION` change; the setter in
  `ipc/settings.ts`. Verify: `settings-projection.test.mjs`, the store's tests (a file without the group loads, a
  junk value falls back to on), and by hand the three type-level controls the existing groups were checked with
  (drop a field from the table → TS1360; drop it from the renderer answer path → TS2741; wire the wrong sanitizer →
  TS2322), recorded under this task.
  - 2026-10-21, against `UPDATE_PREFERENCE_FIELDS`: removing `autoUpdateCheck` from the table → TS1360 (and TS2339
    where it is read); wiring `sanitizeLanguage` to it → TS2322; dropping its `toRenderer` answer → TS2741.
- [x] 5.2 `src/main/ipc/update.ts` (`get`, `check`, `restart`, `openRelease`; pushes `changed`, `showAbout`) and the
  preload `update` namespace and `settings.setUpdateCheck` (listeners drop the event); `restart` refuses unless
  ready; `openRelease` takes no argument. Add both to `scripts/probe-shell.mjs`'s whitelist with their justification
  comments. Verify: `preload-listener-source.test.mjs` and `npm test`.
- [x] 5.3 `src/main/update-notify.ts`: one notification per version, text from both dictionaries, through the
  intake's backend selection (real packaged, stub under the probes' gate); activating it shows the window and
  pushes `showAbout`. Unit test with a fake backend.
- [x] 5.4 Renderer: `PreferencesProvider` gains the switch (through the preferences queue); `AboutSection.tsx`
  shows status, last check (`locale.ts`), progress, "Check now", "Restart to update" / "Download", the switch with its
  hint, no restore control; nothing in development mode without a feed; `showAbout` closes the inbox and opens
  Settings at About. Strings in `en.json` and `zh-TW.json`, `aria-label`s from the dictionary. Verify: `npm run
  typecheck`, `npm run lint`, the dictionary, aria-label and copy-language guards.

## 6. Release script

- [x] 6.1 Move the release-commit rule out of `scripts/release-check.mjs` into a platform-independent function in
  `scripts/lib/release-files.mjs` that does not require a clean tree; `release-check.mjs` keeps its macOS and
  clean-tree rules on top. Verify: the existing release-check tests still pass.
- [x] 6.2 `scripts/release-github.mjs` per U10 (draft → upload → publish, `--clobber` on an existing release,
  `merge-base --is-ancestor`, `git fetch --tags`, argument arrays) and `npm run release:github`. Unit tests with an
  injected `gh` / `git` runner for each refusal of the `desktop-packaging` requirement, the create path (the draft is
  published only after the upload succeeds) and the upload-only path. Verify: the tests fail when the checksum
  comparison is removed and when the publish step runs before the upload.
- [x] 6.3 `CONTRIBUTING.md`: the release order (dist:linux → install:desktop → push → release:github, then the dmg
  from the Mac with the same script).

## 7. Acceptance

- [x] 7.1 `probe:workspace` sections per U9 (feed on `127.0.0.1`, `XDG_CACHE_HOME` and fake AppImages in scratch
  directories, the notification stub): downloading → ready and one notification; restart asks with a running session
  and Cancel leaves the file byte-identical; Restart replaces it and exactly one marker of the new version appears;
  closing the window installs with no marker; `SIGTERM` to the
  probe's Electron with an update ready leaves the file unchanged; switch off → closing the window leaves the file unchanged and the
  feed saw no request; wrong `sha512` → failed, no restart offered; no second notification after a restart; the
  notification opens About (closing the inbox); the telling backend shows "Download"; an unpackaged build
  without a feed checks nothing. ("No check while ready" has no probe carrier — the next check is six hours away —
  and is carried by the coordinator's unit test.) Register any listener port in `scripts/lib/ports.mjs`. Controls, each recorded:
  revert the restart intent → "asks" red; install on cancel → "byte-identical" red; install on a `signal` quit → the
  `SIGTERM` section red; install with the switch off → the switch-off section red; a scheduled check that ignores the
  switch → the switch-off "no request" section red. (The no-check-while-ready rule's control is the unit test's, 3.3.)
  - 2026-10-21, `scripts/probe-workspace-update.mjs` run alone after a build of each mutation (18 assertions; the
    unmutated tree 18/18): restart intent ignored → only "asks, in restart words" red; install on cancel → "Cancel
    leaves the AppImage byte-identical" red (and the two later sections that need the old file); install at a
    signal's quit → only the `SIGTERM` section red; install at a user quit with the switch off → only the switch-off
    close red; scheduled checks ignoring the switch → only "no request" red (2 requests). A first round was void: run
    outside npm, `electron` was not on `PATH` and every mutation failed at launch with no assertion red.
  - `probe:workspace` in full: 170/170 with the sections at its end (2026-10-21).
- [x] 7.2 `probe:package`: seed the switch off in its profile; add the section with it on and hosts mapped to an SNI
  listener (sees `github.com`), and the section with it off (sees nothing past the first check's window). Iterate
  through `PROBE_PACKAGE_APPIMAGE`.
  - 2026-10-21, a trial AppImage of this tree (`-c.directories.output` in a scratch directory, no bump): both update
    sections green — off: the listener received nothing in the 70 s after the restore; on: one connection for
    `github.com` and none for another host. 18/19 overall: "the scan process forks in the packaged artifact" times out
    (CDP 30 s) — **also on master**: the HEAD probe against the installed pre-change 0.2.17 fails the same way, twice.
    Not this change's; reported to the maintainer.
- [x] 7.3 Register `auto-update` in `scripts/scenario-coverage.test.mjs` and fill each scenario's row with its real
  carrier, `greenIfAbsent` and `mutation`; rows only dogfood can carry (the real release restart, macOS against the
  real API, "no non-GitHub host" being green if absent) say so. Verify: `npm test`.
- [x] 7.4 Run `npm test`, `npm run typecheck`, `npm run lint`, and the regression probes `probe:shell` (startup
  no-connection check, preload whitelist), `probe:workspace`, `probe:terminal` and `probe:intake` (shared close
  dialog and notification code).
  - 2026-10-21: `npm test` 2488/2488, typecheck and lint clean; `probe:shell`, `probe:intake` (562 s) and
    `probe:terminal` (502 s) all green and complete; `probe:workspace` 170/170 (7.1).

## 8. Documentation

- [x] 8.1 Website, both languages: `data-and-network.md` (the update check per the `project-website` delta, including
  the paragraph on what runs while the macOS app has no window), `index.mdx` (drop "no update check"), `install.md`
  (how updates work per `app-update`, the versioned-name rename). Verify: `(cd site && npm ci && npm run build)`.
- [x] 8.2 `README.md` and `README.zh-TW.md` (drop "Auto-update is not available yet"; one line on the behavior),
  `docs/PRD.md` §11 Phase 6 and §14, `openspec/config.yaml` status, `CLAUDE.md` (status paragraph, a trigger row for
  `src/main/update-*` and the release script), a new `docs/lessons/update.md` with the measurements of section 1 and
  the reasons `electron-updater`'s installer is not used, and the correction in `docs/lessons/probes.md` (the AppImage
  runtime does overwrite inherited `APPIMAGE` / `APPDIR` / `ARGV0`).

## 9. Dogfood (the real path)

- [x] 9.1 With the maintainer: release the first version carrying this change with the script and install it with
  `install:desktop`; release the next version; confirm the running one downloads, notifies once, restarts into the
  new version through the dialog with sessions restored, and that closing the window without restarting installs.
  Record the dates and versions under this task.
  - 2026-10-24, first part: 0.2.18 released with `release:github` (draft, then published with the AppImage and
    `latest-linux.yml`) and installed with `install:desktop`; the maintainer restarted into it. Its first check ran
    65 s after the start against a latest release (0.2.15) with no `latest-linux.yml` and settled as up to date, no
    error shown. 0.2.19 released; "Check now" downloaded it, `notifiedVersion` became `0.2.19`, "Restart to update"
    asked and restarted: the installed file's sha512 is 0.2.19's, its mode kept (755), the new app started 15:55:36.
    The maintainer saw the system notification. The sessions came back listed and dormant, woken by hand (the
    restore's usual behavior, not this change's).
  - **Found**: the old version's AppImage runtime was still running afterwards, its mount still there and its
    (deleted) image still on disk — the new app held 8–9 descriptors into the old mount (`icudtl.dat`, the snapshot,
    `.pak`, `app.asar`), inherited through the relaunch shell. Fixed in `RELAUNCH_SCRIPT` (closes descriptors above 2;
    bash, or 3–9 under dash); unit tests per shell and a probe check, each red with the 0.2.18 script. A release that
    carries the fix must do the next restart for this to be confirmed on a real update.
  - 2026-10-24, second part: 0.2.20 (the fix) released; on 0.2.19 "Check now" downloaded it and notified, and the
    maintainer **closed the window** without restarting. The installed file's sha512 is 0.2.20's, mode 755; started
    again from the menu, 0.2.20 runs as one AppImage runtime with one mount (the 0.2.19 leftover went with the quit).
  - 2026-10-24, third part: 0.2.21 released; on 0.2.20 "Check now" downloaded it and "Restart to update" restarted
    into it (installed sha512 is 0.2.21's, mode 755). **Nothing of 0.2.20 is left**: one AppImage runtime, one mount,
    the new app's descriptors are all inside its own mount, and no process holds a deleted image — the fix confirmed
    on a real update.
- [ ] 9.2 On the build Mac: the packaged dmg build shows the newer release as available and "Download" opens its page.
  Record under this task.
