## Context

See proposal.md for why. This design records what was measured on the build Mac (Apple Silicon,
macOS 13.7.8, electron-builder 26.15.7, Electron 43.5.0) on 2026-10-08, and the decisions those
measurements forced. Decisions are numbered P… (packaging), W… (window, menu, quit), and A… (acceptance).

The facts that shape the design:

- **Signing with `identity: "-"` seals the bundle, unless a file sits at the top of `Contents/`.**
  The current top-level `extraFiles` puts `LICENSE` and `THIRD_PARTY_LICENSES.txt` in
  `Spekterm.app/Contents/`. `codesign` then fails the build ("code object is not signed at all — In
  subcomponent: …/Contents/LICENSE"). With the same files as `extraResources` (in
  `Contents/Resources/`), the build succeeds:
  - `Identifier=com.spekterm.app`, flags `adhoc` (no longer `linker-signed`);
  - `Sealed Resources version=2 … files=43`;
  - `codesign --verify --deep --strict`: "valid on disk / satisfies its Designated Requirement".

  The dmg is 128 MB. A copy of the app taken out of the mounted dmg still verifies. With a quarantine
  flag added, `spctl -a -t exec` says only "rejected", as it does for any app that is not notarized.
  **The command line cannot show which dialog a user gets**, so that stays with dogfood.
- **electron-builder's own checksum option does not reject a wrong checksum.** With
  `electronDownload: { mirrorOptions: {}, checksums: { "electron-v43.5.0-darwin-arm64.zip": "000…" } }`,
  empty caches (`electron_config_cache`, `ELECTRON_BUILDER_CACHE`), and `ELECTRON_MIRROR` set, the build
  downloaded and packaged without error, exactly as it did with the correct checksum. The source explains
  why: `createDownloadOpts` (`ElectronFramework.js`) keeps only `mirror` from `mirrorOptions` and drops
  `checksums`. The npm package `electron` ships `checksums.json`. Its entry for
  `electron-v43.5.0-darwin-arm64.zip` (`0ff66247…`) equals GitHub's `SHASUMS256.txt` and the downloaded
  file. `@electron/get` (5.1.0, a dependency of `electron`) accepts a `checksums` map and verifies
  against it even on a cache hit.
- **The Mac app carries none of Electron's and Chromium's licence texts.** The Electron zip has
  `LICENSE` and `LICENSES.chromium.html` at its root. On Linux they land at the AppImage root, as
  `LICENSE.electron.txt` and `LICENSES.chromium.html`. On macOS the zip is unpacked into the output
  directory *outside* the `.app`, and the dmg carries only the `.app`. This happens on the default
  download path too, not only with `electronDist`.
- **Platform-level file sets are added to the top-level ones, not substituted for them**
  (`fileMatcher.js`: the top-level `config[name]` first, then the platform's). A top-level `extraFiles`
  therefore always reaches `Contents/` on macOS and breaks signing.
- **`open` does not give a desktop launch's environment.** `man open` on the Mac: "Opened applications
  inherit environment variables just as if you had launched the application directly through its full
  path." An app opened from an SSH shell inherits that shell's `PATH`.
- **`ps -E` / `ps eww` did not show another process's environment** on macOS 13: a marker variable set
  on `/bin/sleep` was absent, and its argv was present.
- **A zip passed as `electronDist` is unpacked without electron-builder's cleanup**
  (`ElectronFramework.js`: "do not clean up after unpacking"). `Contents/Resources/default_app.asar`
  (111 KB, Electron's placeholder app) therefore ships. The normal download path deletes it, and the
  Linux build has none.
- **The Linux release directory already carries update metadata** (`latest-linux.yml`, and
  `app-update.yml` inside the app) because the GitHub repository is inferred as a publish target. The Mac
  build adds `latest-mac.yml`. Nothing reads these files (no auto-update).
- **The close guard's order test** (`close-guard.ts`): a close the user starts emits `close` before any
  `before-quit`; a quit started by the OS or a signal emits `before-quit` first. `index.ts` sets
  `quitting` on `before-quit`.
- **`Menu.setApplicationMenu(null)` runs inside `createWindow()`**, once per window.
- **On window destroy, `ipc/terminal.ts` kills the window's ptys but does not call
  `disposeConversationFor`.** Only the `did-navigate` path calls it. On Linux the process ends with the
  window, so the leak never lived long.
- **A notification click calls `bringToFront()`**, which returns when there is no window, then
  `openInbox?.()` or `revealHandoffBrief()`. Both reach a renderer that no longer exists.
- **The close dialog's copy** (`en.json` `consequence`) says that shells "restart in their last
  directory". On macOS, `cwdOf()` reads `/proc/<pid>/cwd` and returns `undefined`, so they restart in
  their folder.
- **The Mac has `claude` at `~/.local/bin/claude`** (2.1.294), which a login shell resolves.
- **macOS's `env` supports `-0`** (measured on 13.7): it prints NUL-separated entries. `user-env.ts`'s
  comment says that this flag is GNU-only and untested on macOS. That is wrong, and the comment is
  corrected; the environment recovery works there as on Linux.
- **Privacy prompts are attributed to the app that runs the program.** On the first hands-on run of the
  trial build, macOS showed prompts naming Spekterm for Calendars, Photos, Contacts, Reminders, and the
  Desktop, Documents, and Downloads folders. The privacy log (`com.apple.TCC`) shows that the accessing
  process was `claude` in an agent session, reading under the home directory. Spekterm was the
  "responsible" process. A terminal application that has answered these prompts before never shows them.
  Every ad-hoc build is a new identity, so the prompts are expected to return after each update. This is
  the strongest user-facing argument for a Developer ID later.
- **UI scripting from an SSH session is not permitted yet.** `osascript` to System Events timed out with
  `-1712`. macOS asks the user, on the Mac's screen, to allow the SSH session to control the computer.

## Goals / Non-Goals

**Goals:**

- A Mac release command that cannot produce an artifact whose version and source disagree.
- An artifact whose seal verifies, verified on the dmg's own copy.
- Electron's binary checked against a checksum this repo pins, whatever server delivered it.
- macOS quits and window lifecycle that keep the existing confirmation rules true.

**Non-Goals:**

- Changing how `dist:linux` downloads or verifies Electron. It uses electron-builder's normal path,
  which checks against GitHub's `SHASUMS256.txt` from the same host as the binary.
- Removing the update metadata files (`latest-*.yml`, `app-update.yml`). They exist on Linux today, and
  they matter only once auto-update is considered.
- `Cmd+W` and a Window menu. In spekterm, closing the window ends every session, so a one-key way to do
  that is not added. `Ctrl+Shift+W` closes a session, as on Linux.

## Decisions

### P1. The macOS target lives in `build.mac` and `build.dmg`; the licences move per platform

```
build.mac: { target: [{ target: "dmg", arch: ["arm64"] }], icon: "build/icon.png",
             identity: "-", hardenedRuntime: false, category: "public.app-category.developer-tools",
             extraResources: [LICENSE, THIRD_PARTY_LICENSES.txt] }
build.linux.extraFiles: [LICENSE, THIRD_PARTY_LICENSES.txt]   (moved from the top level)
```

- **`identity: "-"`**: electron-builder's explicit opt-in to ad-hoc signing. Leaving it unset searches
  the keychain and signs nothing when nothing is found.
- **`hardenedRuntime: false`**: the hardened runtime matters only for notarization. Combined with
  ad-hoc signing, it needs the `disable-library-validation` entitlement, or the app may fail to load
  its own frameworks. It would add a failure mode and buy nothing.
- **The licences become `extraResources` on macOS** (measured above). They move from the top level into
  `build.linux.extraFiles`. Platform sets are added to the top-level set, so a top-level entry would
  still land in `Contents/` and break signing. The Windows location is decided when Windows is built.
- **Electron's and Chromium's licence texts are copied in by the `afterPack` hook (P3)** on macOS:
  `LICENSE` becomes `Contents/Resources/LICENSE.electron.txt` (the Linux name), together with
  `LICENSES.chromium.html`. Measured: for macOS, electron-builder deletes the zip's copies from the output directory before `afterPack` runs (`electronMac.js`). `package-mac.mjs` therefore extracts them from the archive it has just verified, into a temporary directory named to the hook in `ELECTRON_LICENCES_DIR`. `node_modules/electron/dist` is not a source: Electron 43 has no postinstall, and after `npm ci` on the Mac it did not exist. The hook refuses a macOS build without the variable, so **a trial build also goes through `node scripts/package-mac.mjs`** (without the release check), not through a bare `electron-builder --mac`. The copy
  happens before signing, so the seal covers them. Linux already carries both.
- **Alternative: putting the licences beside the app in the dmg window.** They would not be "inside the
  artifact" once the app is copied to Applications.

`project-license` says "artifact root". For a macOS bundle that is defined as `Contents/Resources/`, the
place the platform reserves for non-code files. The requirement names Electron's and Chromium's texts
explicitly. The guard and the scenario that read the licences learn the per-platform location.

The guard that keeps `site/` out of the app (`scripts/site-boundary.test.mjs`) reads only the top-level
`files`, `extraFiles`, and `extraResources`. It is extended to every
`build.{linux,mac,win}.{files,extraFiles,extraResources}`. Its new control: `build.mac.extraResources`
selecting `site/**` makes it fail. The scenario coverage table's mutation text is updated with it.

### P2. The Mac command builds only a release commit, on a clean tree, on macOS

`npm run dist:mac` = `node scripts/release-check.mjs && npm ci && npm run build &&
node scripts/package-mac.mjs && node scripts/prune-release.mjs`.

`release-check.mjs` refuses unless:

- the platform is `darwin`;
- `git status --porcelain` (untracked files included) is empty;
- `HEAD`'s subject is `chore(release): <version>`, where `<version>` is the version `HEAD:package.json`
  declares;
- `HEAD` changed exactly `package.json` and `package-lock.json` relative to its parent. This rejects an
  amended bump commit, or a hand-made commit that reuses the subject. It needs a clone that is at least
  two commits deep; a shallower clone is refused with that instruction.

All git calls run with `LC_ALL=C`, as `release-bump.mjs` does.

**`npm ci` runs before the build.** A clean tree says nothing about `node_modules`, which may have
drifted from the lockfile. The About section would then claim a clean build of a commit whose
dependencies it does not contain. The same gap exists on Linux. It becomes an issue rather than part of
this change, because `dist:linux` deliberately builds from dirty trees.

Each refusal states the fix: for example, "check out the release commit of 0.2.4", or "this is not a
release; use `npm run build && node scripts/package-mac.mjs` to try a build".

Like `release-bump.mjs`, it takes the repo root from `argv` so its tests can build git fixtures. These
are the controls:

- a commit after the release commit;
- an untracked file;
- a `chore(release)` subject whose version differs from `package.json`;
- a commit with the right subject that also changes another file;
- a detached `HEAD` on the release commit, which must build.

- **Why the subject and not a tag**: `dist:linux` deliberately creates no tags (`build-identity`).
  The published `v0.2.1` tag was made by hand on the `chore(release): 0.2.1` commit, which shows that
  the commit is what identifies a release.
- **Why untracked files count**: a file in `src/` that nothing tracks can still be bundled if a tracked
  file imports it. Being strict here costs nothing on a build machine that only builds releases.
- **A detached `HEAD` is accepted.** Checking out an older release commit leaves `HEAD` detached, and
  the subject and version check already prove the identity. `release-bump.mjs` refuses a detached
  `HEAD` for a different reason: it creates a commit, and a commit made there would be lost.
- **Alternative: suffixing the commit to the version on non-release commits.** It keeps one command for
  both uses, but the two platforms' artifacts would then disagree on the version of the same release.

`build-identity`'s About section is expected to show `dirty: false` and the release commit for a Mac
artifact. The macOS probe reads it (A1 step 7), so this is checked, not assumed.

### P3. `@electron/get` fetches Electron against pinned checksums; electron-builder gets the zip

`package-mac.mjs`:

1. Calls `@electron/get`'s `downloadArtifact` for the installed `electron` version, `darwin`, `arm64`,
   with `checksums` set to `node_modules/electron/checksums.json`. That is the function `electron`'s own
   postinstall uses, so the mirror rules match: `ELECTRON_MIRROR`, `npm_config_electron_mirror`, the
   custom-directory template, and its cache. It verifies against the given map on every call. A cache
   hit that does not match is discarded and downloaded again, and a download that does not match
   throws. Because `dist:mac` runs `npm ci` first, and `electron`'s postinstall fills the same cache
   against the same checksums, `package-mac` normally hits the cache. The empty-cache path through a
   mirror is exercised once by hand and recorded (tasks).
2. Runs `electron-builder --mac -c.electronDist=<zip>`.

`@electron/get` becomes a **devDependency pinned to the version installed for `electron`**. `electron`
declares a range (`^5.0.0`), so the pin is the version the lockfile resolved. Today it is reachable only
because npm hoists it, and a build script must not rest on that. A unit guard checks that the declared
version equals the installed one that `electron` uses.

A checksum mismatch is reported in `@electron/get`'s terms: the archive's name and that the checksum did
not match. It deletes the temporary file, so both hashes are not available to print.

An `afterPack` hook (`scripts/after-pack.cjs`, declared in `build.afterPack`) acts only on macOS:

- it deletes `Contents/Resources/default_app.asar` and tolerates its absence, since a trial
  `electron-builder --mac` without `electronDist` takes the default cleanup path;
- it copies Electron's and Chromium's licence texts into the bundle (P1).

It runs before signing (`platformPackager.js`: `afterPack` → fuses → sign), so the seal covers the result.
The macOS probe asserts that `default_app.asar` is absent and that both licence texts are present. A build
without the hook is the control for both.

- **Why not electron-builder's `checksums`**: it drops them when a mirror is configured (Context).
- **Why not our own downloader**: the mirror URL rules have several forms, all of which `@electron/get`
  already implements. A second implementation would differ from the one `npm ci` uses.
- **Why not trust the mirror's `SHASUMS256.txt`**: then the mirror vouches for its own file.
- **Why `checksums.json`**: npm installed it under the lockfile's integrity check, and it moves with the
  `electron` version without anyone editing a hash. The control is a run with one entry of the map
  altered, which must fail.

### P4. Pruning groups artifacts per platform

`prune-release.mjs` recognises `Spekterm-<v>.AppImage` and `Spekterm-<v>-arm64.dmg` as separate groups.
It keeps the newest two of each by version order and deletes a dmg's `.blockmap` together with it. Linux
and macOS never share a `release/` directory in practice, but grouping per platform means one never
counts against the other. The control for "version order, not dictionary order" is extended to dmg
names.

### W1. The application menu is set once per process, per platform

`setApplicationMenu` moves from `createWindow()` to `whenReady`:

- **Linux and Windows**: `null`, as today. The probe already checks that `Alt` shows nothing.
- **macOS**: a menu template with two menus.
  - **The app menu**:
    - About (role `about`; the native panel shows the version);
    - a separator;
    - Hide, Hide Others, Show All (roles);
    - a separator;
    - **Quit Spekterm**: a custom item with accelerator `Cmd+Q`, see W2.
  - **The Edit menu**: Undo, Redo, Cut, Copy, Paste, Select All (roles).

  Every label comes from the dictionaries (`ui-localization`). On macOS a role item honours a `label`
  override. This is from memory of Electron's documentation and is checked on the Mac. The menu is
  rebuilt when the UI language changes, from a callback that `setLanguage` (`ipc/settings.ts`) calls.

  The app menu's title is the bundle name, `Spekterm`, and no dictionary controls it. The items that
  name the app use the same capitalised name (`Quit Spekterm`, `Hide Spekterm`), following the rule that
  operating-system display names use `productName`.

**The terminal's `Cmd+V` handler stops letting the key through.** `xterm.ts` handles `Cmd+V` itself
(`onPaste()`) and returns `false` from the custom key handler, which does not call `preventDefault`.
The unhandled key equivalent may then reach the Edit menu's Paste and paste a second time. The handler
calls `preventDefault()` for the keys it handles itself: `Cmd+V`, and `Cmd+C` with a selection. Whether
the double paste happens is measured first, without the fix (A2). That is the control group. The same
check runs in Monaco and in an ordinary text field (the session rename dialog).

### W2. A close that is part of a quit finishes the quit

One rule covers every quit on macOS: **when a close belongs to a quit, the main process calls
`app.quit()` again once that close has been allowed to finish.** "Belongs to a quit" has two sources:

- **`Cmd+Q` and the app menu's Quit.** The custom item closes the window, with the quit intent attached,
  when a window exists, and calls `app.quit()` when none does. The close then takes the normal path: the
  unsaved-changes question, then the running-sessions question. This is why the item does not use the
  Quit role. The role quits through `before-quit` first, which the guard reads as a signal and does not
  ask about.
- **A quit request from the OS** (the Dock's Quit, logout, shutdown) or a signal. It emits `before-quit`
  first, as today: no sessions question, but the unsaved-changes question may hold the quit
  (`preventDefault`), and Electron then abandons that quit. On Linux, `window-all-closed` quit the app
  after the user answered. On macOS it does not, so the user who chose Quit would be left with an app
  and no window.

**The mechanism.** `guardWindowClose` gains an `onClosed(intent)` callback, and the guard records the
intent of the close it is deciding:

- `quit` when the close came from the Quit item;
- `quit` when `before-quit` came first;
- `close` otherwise.

The intent is not stored on the window. It lives in the guard's decision for that one close, and a
cancelled decision discards it, so a later plain close cannot turn into a quit (the "one question at a
time" rule). Three paths reach `onClosed('quit')`, and each gets a unit test:

1. **nothing to ask**: the close proceeds at once;
2. **asked and confirmed**;
3. **unsaved changes answered on a quit that started with `before-quit`**.

**A quit request that arrives while a dialog is already open upgrades that close's intent to `quit`.**
Such a request is a signal, the quit Apple event, or the Quit item. It shows no second dialog. Answering
close then finishes the quit; answering cancel discards the intent with the decision. Without the
upgrade, on macOS a quit pressed during the dialog would close the window and leave the application
running. The callback calls `app.quit()`. On Linux the extra call is harmless: the process is already
quitting through `window-all-closed`.

- **The Dock's Quit, logout, and shutdown do not ask about sessions.** The order that makes this so is
  measured on the Mac first (A2). The measurement uses `osascript -e 'tell application id
  "com.spekterm.app" to quit'`, which sends the same quit Apple event the Dock and logout send. If that
  event turns out to emit `close` first, the spec's scenario for it is revised before the code is
  written; the mechanism above does not change.
- **`SIGTERM` is measured too** (A2), with `kill` against the probe's instance. Electron is expected to
  handle it as on Linux, but that has not been measured.

### W3. Closing the window leaves the app running; activating reopens it

`window-all-closed` already skips `app.quit()` on `darwin`, and `activate` already calls `createWindow`
when no window exists. The restored sessions come back dormant: the renderer restores them from
`sessions.json`, which the close flushed. Three fixes make this path correct:

1. **`destroyed` releases the conversation tracking** (`disposeConversationFor`), as `did-navigate`
   does.
2. **`ensureWindow()`** replaces `bringToFront()` at every place that acts on a window from outside it:
   notification clicks, opening the inbox, revealing a handoff brief. It creates a window when there is
   none, and it resolves only when **that window's renderer says it is ready**. A new
   `app:rendererReady` IPC carries that signal. The renderer sends it once its intake and handoff
   listeners are mounted. It is added to the preload allow-list, which `probe:shell` checks.

   Both delivery paths need the signal today:
   - `openInbox` broadcasts to the renderers that have already called `intake:list`;
   - `revealHandoffBrief` sends to every window.

   A message sent before the new renderer has mounted is lost. `did-finish-load` is too early, because
   it fires before React mounts the listeners.
3. **An audit of main-process state keyed to a window**, done as a task. It covers
   `webContents.id`-keyed maps, per-renderer watchers, intake and handoff broadcasters, and `quitState`.
   It confirms that each entry is released on `destroyed` and that a second window starts clean. The
   review found `quitState` and close-guard state per window, and the inbox broadcaster pruning destroyed
   targets.

On Linux nothing changes: the process still ends with its window.

### W4. The close dialog's wording follows the platform

`consequence` is split along two lines:

- **Where shells restart.** Linux keeps "shells restart in their last directory"; on macOS they restart
  in their folder.
- **What is closing.** "Closing spekterm ends them" is not true on macOS, where closing the window
  leaves the app running. It says "Closing the window ends them" there.

The first choice follows a new predicate, `ptyCwdReadable`, which `readPtyCwd` itself uses. `cwdOf()`
has no such test today: it reads `/proc` and returns `undefined` on failure. The wording and the
behaviour therefore cannot drift apart. The second choice follows whether closing the window quits, the
same condition `window-all-closed` uses. Both dictionaries gain the keys, and the dictionary completeness
guard covers them.

### A1. The macOS acceptance is its own probe, run on the Mac

`scripts/probe-package-mac.mjs`, run as `npm run probe:package:mac`, at the same cost level as
`probe:package`: once per release, not part of `test:e2e`. It shares `lib/cdp`, `lib/sections`,
`lib/copy`, and the language seeding with the Linux probe. It does not share the launch: `xvfb`,
AppImage, and `/proc` are all Linux-specific, and a single probe that branches on the platform at every
step would hide which half ran.

1. Mounts the newest `release/Spekterm-<v>-arm64.dmg` (`hdiutil attach -nobrowse -readonly`), copies the
   app out with `ditto`, and detaches. The probe tests the dmg's copy, not `release/mac-arm64/`.
2. `codesign --verify --deep --strict` passes. `Contents/Resources/default_app.asar` is absent.
   `LICENSE`, `THIRD_PARTY_LICENSES.txt`, `LICENSE.electron.txt`, and `LICENSES.chromium.html` are
   present in `Contents/Resources/`.
3. **Launches from a desktop launch's environment, not the probe's.** `open` passes the caller's
   environment on (Context), so the probe runs it as `env -i HOME=… USER=… LOGNAME=… SHELL=… TMPDIR=…
   PATH=/usr/bin:/bin:/usr/sbin:/sbin open -n -a <app> --args --remote-debugging-port=<port>
   --user-data-dir=<tmp>`. That is the minimal environment launchd gives an app started from Finder or
   the Dock. The control for it: in that same environment, `/bin/sh -c 'command -v claude'` must print
   nothing. If it prints a path, the environment is not minimal and the agent check proves nothing.
4. **This run's processes are found by argv, not by environment.** The main process is the one whose
   arguments carry this run's unique `--user-data-dir`. Its descendants are found by walking
   `ps -o pid,ppid,command`. `ps -E` did not show another process's environment (Context).
5. The Linux probe's checks: `document.title`, the production CSP, a shell session whose pty process
   exists among the descendants and whose command leaves its side effect on disk.
6. An agent session reaches `claude`: a process with `claude` as its command appears among the
   descendants once an agent session is opened. A shell session writes `command -v claude` to a file,
   which must be non-empty. Together with the control in step 3, this shows that a desktop-launched app
   resolves what the minimal launch lacked. It does not say which mechanism supplied it: on this Mac a
   login shell already resolves `claude`. If `claude` is not installed, the section reports "not run",
   not green.
7. The build identity in Settings: the version equals the dmg's file name, the commit is the release
   commit, and the working tree is clean. This is the same reading `probe:package` does on Linux.
8. The macOS behaviour, driven through System Events (UI scripting), which presses real key equivalents
   and clicks real menu items. Covered:
   - the menu holds exactly the defined items, and none is bound to `Cmd+W`. Items macOS adds by itself
     to a menu named Edit, such as Start Dictation and Emoji & Symbols, are recognised and not counted as
     the application's. Whether macOS adds them is checked first;
   - menu labels change with the UI language;
   - `Cmd+V` in the terminal and in the editor pastes once;
   - `Cmd+C` and `Cmd+V` work in the rename dialog's text field;
   - `Cmd+Q` with nothing to ask quits;
   - `Cmd+Q` with a running session asks: cancel keeps the app, and a later confirmed close leaves it
     running with no window; confirm ends it;
   - `Cmd+Q` while the close dialog is open, then answering close, quits;
   - closing the window leaves the process running, with no window;
   - `open -a` (activate) opens a window whose sessions are dormant;
   - the second window's menu still has Quit and Edit;
   - Quit with no window quits.
9. The quit Apple event (`osascript … to quit`, needing the Automation permission), in two runs:
   - with a running session and nothing unsaved: no dialog, and the app exits;
   - with an unsaved file: the unsaved-changes dialog appears, and answering "don't save" makes the app
     exit.

**UI scripting needs a one-time permission on the Mac.** System Settings → Privacy & Security →
Accessibility (and Automation for System Events), for the program the probe runs from. The probe's
pre-flight detects the missing permission and fails with that instruction. It does not wait for the
AppleEvent timeout (measured: `-1712` after two minutes). The sections that need the permission are
declared to depend on it, so they report "not run". The pre-flight also requires a logged-in, unlocked
session on the Mac's screen: the probe opens real windows there, and it says so before starting.

Registration:

- its debugging ports are declared in `scripts/lib/ports.mjs`;
- it is left out of `run-probes.mjs` (`test:e2e`);
- the new unit tests are covered by the `test:unit` globs, which `test-glob.test.mjs` enforces.

**What the probe meets that the Linux probe does not:**

- **The real native dialogs and notifications.** A packaged app never uses the close-dialog stand-in or
  the notification stand-in (`usingThrowawayProfile()` is false when packaged). The `Cmd+Q`, cancel,
  confirm, "don't save", and Apple-event sections read and click the real sheet through UI scripting.
- **Privacy prompts.** The agent section starts a real `claude`, which may raise prompts naming Spekterm
  (Context) and take focus. It therefore runs last, after every key-driven section.
- **Where `Cmd+Q` is pressed.** Focus in the terminal and focus in the editor are the common cases, and
  the ones a renderer could swallow. Each is pressed once.
- **Which bundle it tests.** `PROBE_PACKAGE_MAC_DMG=<path>` (or an `.app` path) overrides the default.
  The default is the dmg for the declared version, named from `package.json`. The controls of the tasks
  (unsealed, without the hook, before the fixes) are not release builds, so they need the override.
- **How it is launched.** Directly with `node scripts/probe-package-mac.mjs`: `run-probe.mjs` wraps
  every probe in `xvfb-run`, which macOS does not have.
- **How it stops the app.** `lib/quit.mjs` gains a pid-based `quitAndWait`, because an app started
  through `open` is not the probe's child. `quit-source.test.mjs` forbids raw signals in probes.
  `preflight.mjs`'s port-holder lookup is checked on macOS.
- **Two cheap static checks**:
  - `Info.plist`'s `LSMinimumSystemVersion` equals the minimum the docs state;
  - the top of `Contents/` holds no licence file.

**The main-process logic under unit test is moved out of modules that import `electron`.** `node --import
tsx` cannot import `electron` (no `BrowserWindow` export). The menu template builder, `ensureWindow`, and
the per-window cleanup each live in a module whose dependencies are injected, as `close-guard.ts`
already does. The modules that wire them to Electron stay thin.

- **Why not CDP for the keys**: CDP input events go to the renderer. The menu's key equivalents are
  handled by the OS before the renderer, which is exactly the layer being tested.
- **Why not `--inspect` on the main process to click the menu items**: it would test that the items
  exist, not that the keys reach them.

### A2. Measurements come first, before the code they decide

The first implementation tasks run on the Mac against a build without the W1/W2 fixes:

- whether `Cmd+V` in the terminal pastes twice once an Edit menu exists;
- whether macOS adds its own items to a menu named Edit;
- the event order of a quit Apple event (`osascript … to quit`), which may need the Automation
  permission;
- the event order of `SIGTERM` (`kill` from SSH; no permission needed).

Their results are recorded in the change, and they are the controls for the fixes' probe sections.

**A notification click with no window is not automated.** Clicking a Notification Center banner through
UI scripting is fragile. Instead, `ensureWindow` is covered by unit tests of its logic (create, wait for
ready, then act), and the real click is a dogfood item.

## Risks / Trade-offs

- [Every ad-hoc build is a different code identity, so macOS may ask again after each update for
  notification permission, access to protected folders such as Documents and Desktop, and the keychain
  item Chromium creates] → Dogfood checks one update from N to N+1. The install docs say that updates
  may ask again. The spec records the gap.
- [The quarantine dialog cannot be checked from the command line] → Dogfood: download the dmg from the
  GitHub release in a browser on the Mac. Confirm the "unidentified developer" path and the "Open
  Anyway" button. The previous unsealed build is the "damaged" control, rebuilt with `identity: null`
  for that check only.
- [Tested only on macOS 13.7; macOS 15 changed how an unidentified app is allowed (no Control-click
  Open)] → The docs give both paths and state the tested version.
- [UI scripting permission granted to the SSH session's program is broad] → It is granted on the
  maintainer's machine for the probe. The probe documents it, and the permission can be revoked
  afterwards. Nothing in the app depends on it.
- [`Ctrl+↑` / `Ctrl+↓` are taken by Mission Control] → Documented as a macOS limitation, with an issue.
  Rebinding is out of scope.
- [The Mac build depends on one person's machine] → Accepted for now. CI is the follow-up named in the
  proposal.

## Migration Plan

**During development, the code reaches the Mac without a commit.** The working tree is copied to the Mac's
clone with `rsync` (excluding `node_modules`, `out`, `release`, and `.git`). That clone is then dirty, so
`dist:mac` refuses there by design. Development builds are trial builds (`node scripts/package-mac.mjs`, which skips the release check), and the
probe takes them through its path override. No branch is created, and nothing is committed before the
maintainer has tried the result on the Mac.

**Linux acceptance does not bump during development.** `probe:package` starts with `dist:linux`, which
bumps, and the bump refuses while `package.json` carries this change's uncommitted edits. Development runs
therefore build the AppImage with `npm run build && npx electron-builder --linux`, and run the probe with
`PROBE_PACKAGE_APPIMAGE=<path>`.

**The first release, in order. Each step that leaves the machine waits for the maintainer's approval.**

1. Commit the change's code, tests, and docs except `site/`, after the maintainer has tried it.
2. `dist:linux`: bump and package.
3. Push to master (approval: it runs CI).
4. On the Mac: `git pull`, `dist:mac`, `probe:package:mac`.
5. Upload the AppImage and the dmg to the GitHub release (approval: public).
6. Commit and push the `site/` changes (approval: a push touching `site/` deploys the website). They go
   last so that the website never offers a macOS download that the release does not have yet.

Rollback: a release can omit the dmg. Nothing on Linux depends on the macOS path. The website changes are
one commit that can be reverted.

## Open Questions

- The exact text of the macOS install steps for macOS 15 and later. It is answered by trying it on a
  machine with that version; the docs carry a note until then.
