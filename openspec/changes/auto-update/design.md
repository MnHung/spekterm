## Context

See proposal.md for the motivation and the maintainer's three rulings. The facts the design rests on:

- **The update metadata is already built.** electron-builder 26.15.7 infers the GitHub provider from
  `repository` (no `publish` field), so `npm run dist:linux` already writes `release/latest-linux.yml` (version,
  file name, SHA-512, `blockMapSize` — the AppImage carries its block map inside the file, so a differential
  download needs no extra asset; written under `--publish never` too) and puts `app-update.yml` (`provider: github,
  owner: spekhq, repo: spekterm, updaterCacheDirName: spekterm-updater`) into the packaged resources. **No release
  has ever carried `latest-linux.yml`**: releases are created by hand, with hand-written notes, and carry only the
  AppImage and the dmg.
- **Where the AppImage lives.** `npm run install:desktop` copies it to `~/.local/bin/Spekterm.AppImage` (no
  version in the name) through a staging file and a rename, and the `.desktop` entry runs that path. A user who
  downloaded from GitHub runs `Spekterm-<v>.AppImage` from wherever they saved it.
- **The AppImage runtime overwrites `APPIMAGE`, `APPDIR` and `ARGV0`** for each image it starts, even when they
  are inherited (measured by the review with strace; only `OWD` is inherited). `docs/lessons/probes.md` says the
  opposite and is corrected by this change. A run with `--appimage-extract-and-run` is recognisable only by
  `APPDIR`'s basename (`appimage_extracted_*`); the flag itself is removed from `argv`.
- **`electron-updater` 6.8.9, read from its source:**
  - The GitHub provider reads the latest tag from `github.com/<owner>/<repo>/releases/latest`, finds its entry in
    `releases.atom`, then downloads that release's `latest-linux.yml` and the file (redirected to GitHub's asset
    host). It talks through Electron's `net` on a session partition of its own: the browser engine's network
    stack.
  - A missing `latest-linux.yml` is `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`; a bad download is
    `ERR_CHECKSUM_MISMATCH`; a cached download is re-hashed on the next check.
  - **Its installer is unsafe for us in three ways.** `AppImageUpdater.doInstall` `unlink`s `$APPIMAGE` before it
    `mv`s the new file in (a failure in between leaves no AppImage). When a newer version appears while one is
    ready, the cache directory is emptied but the helper keeps the old file path, so a later `install()` unlinks
    the user's AppImage and then fails to move a file that no longer exists. And `autoInstallOnAppQuit` registers
    its `quit` handler only at the moment a download completes with the flag on, and installs on every quit with
    exit code 0 — a logout included.
  - `quitAndInstall()` calls `install()` first and `app.quit()` after; that quit starts with `before-quit`, which
    the close guard reads as a signal (`QuitState.quitting`).
- **The close guard** (`close-guard.ts`) has `closeForQuit()`: the normal close questions, then the quit only if
  the close went ahead (`onQuitClose` → `app.quit()` on `closed`); a cancelled close discards the intent. There is
  no `app.relaunch` anywhere, no single-instance lock, and no `app.exit`, so `will-quit` always runs.
- **Preferences** are one file (`preferences.json`, version 1) with per-group field tables bound by `satisfies`;
  adding a group must not bump the version (a mismatch quarantines the whole file). A boolean that is on by
  default is stored by deleting the field (`gpuAcceleration`; `null` is only the setter's argument).
- **Network guards**: `scripts/network-surface.test.mjs` lists `autoUpdater` as a network member and flags every
  package import; `probe:shell` checks that startup opens no browser-engine connection within a 10 s settle window
  (it runs an unpackaged build). `scripts/lib/sni-listener.mjs` and `resolverRulesArg` exist for that check.

## Goals / Non-Goals

**Goals:**

- A Linux AppImage install keeps itself current with no step but a confirmed restart (or closing the window).
- No session ends, and no file is replaced, without the question a close asks; there is never a moment in which
  the AppImage path holds no runnable file.
- Every other build (macOS, a Linux build that cannot replace itself) learns of a new release and links to it.
- The only new connections are to GitHub, from a packaged build, with the switch on or after "Check now".

**Non-Goals:**

- Installing on macOS (needs a Developer ID signature and notarization; PRD §14) and Windows (no artifact).
- Release channels, pre-releases, rollback, staged rollout, or a signature of our own over the release.
- Telling the paired phone (`mobile-remote-bridge`): no protocol change.
- Release notes inside the app: the release page has them.
- Automating the macOS upload from the build Mac (the release script runs there too if `gh` is set up; it is not
  wired into `dist:mac`).
- Keeping flags the user added to the command line across an update restart (a dogfood
  `--remote-debugging-port=9333` is dropped; the user starts it again by hand).

## Decisions

### U1. Two backends behind one coordinator; `electron-updater` only checks and downloads

`update-coordinator.ts` owns the state machine (`idle → checking → up-to-date | downloading → ready | available
| failed`), the timer, the switch, the notification and the IPC; it imports no Electron module and no network
module, so it is unit-tested with fakes. It chooses one backend at startup:

- **installing** (`update-installer.ts`, the only importer of `electron-updater`): Linux, packaged (or a probe
  feed, U9), `process.env.APPIMAGE` an absolute path to an existing regular file whose directory is writable
  (`fs.accessSync(dir, W_OK)`), and `APPDIR`'s basename not starting with `appimage_extracted_`. It sets
  `autoDownload = false`, `autoInstallOnAppQuit = false`, `autoRunAppAfterInstall = false`, `allowDowngrade =
  false`, `allowPrerelease = false`, its logger routed to `console` with an `[update]` prefix. After a check finds a
  version that passes U2, the coordinator calls `downloadUpdate()`. **It never calls `install()` or
  `quitAndInstall()`**: the downloaded file's path from `update-downloaded` is all we take, and U4 installs it.
- **telling** (`update-release-check.ts`): every other packaged build. One `net.fetch` of
  `https://api.github.com/repos/spekhq/spekterm/releases/latest` (drafts and pre-releases excluded by the
  endpoint), with `Accept: application/vnd.github+json` and a 15 s timeout.

*Alternative*: `electron-updater` on macOS with `autoDownload = false`. Rejected: it needs a `latest-mac.yml` the
dmg-only build does not produce, and `MacUpdater` is built around Squirrel.Mac, which we cannot use. *Alternative*:
the REST check on Linux too. Rejected: two sources of "which version is latest" can disagree; the installing
backend's check reads the file it then downloads. *Alternative*: `electron-updater`'s installer. Rejected for the
three reasons in Context.

### U2. Only our own strings reach the screen

From a release the app keeps **only a version**: `tag_name` (REST) or `version` (updater) must match
`^v?(\d+)\.(\d+)\.(\d+)$`, else the check fails ("unexpected answer") and nothing is downloaded (hence
`autoDownload = false`). The release page link is built from that version
(`https://github.com/spekhq/spekterm/releases/tag/v<x.y.z>`), never taken from `html_url`. Release names and notes
are never read. Newer means a greater numeric triple than `app.getVersion()`. So the notification and Settings carry
no third-party text (`docs/lessons/intake.md` §7 does not apply).

### U3. When it checks

- Not at all unless `app.isPackaged` or a probe feed is configured (U9).
- First check 60 s after the restore gate opens **for the first time** in the process (`onRestoreGateOpen`
  fires again on reload and on a new window; later firings are ignored). The spec's bound is "not within the
  first minute after the window restored", well past `probe:shell`'s 10 s settle window.
- Then every 6 hours (`setInterval`, cleared on `will-quit`), and on `powerMonitor` `resume` when the last check is
  older than 6 hours. A tick skips while a check or download runs.
- **No check while an update is `ready`** — neither scheduled nor "Check now" ("Check now" is replaced by "Restart
  to update" in that state). A newer release is handled after the ready one is installed. This keeps
  `electron-updater` from emptying the cache under the file U4 is about to install.
- "Check now" checks immediately, whatever the switch, and (installing backend) downloads what it finds.
- Failures (offline, DNS, 5xx, timeout, rate limit, checksum mismatch) set `failed` with the time and a short
  reason; the next scheduled check retries. `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` (a release still being
  assembled, U10) counts as up to date.

### U4. We install, in `will-quit`, by copy and atomic rename

Two ways to install, one implementation (`update-install.ts`, injected `fs` / `app` for unit tests):

- **Restart to update.** `GuardedWindow` gains `closeForRestart()`, built like `closeForQuit()`: the normal close
  path (unsaved changes, then running sessions) with a prompt worded for a restart (`close-prompt.ts` gets a
  `restart` intent: title "Restart to update?", confirm "Restart", Cancel the default, the same session list and
  the same "claude sessions resume, shells restart in …" line). Nothing to ask → it closes at once. A cancelled
  close discards the intent. When the close goes ahead, `onRestartClose` marks the quit `restart` and quits on
  `closed`.
- **At a quit the user started.** The quit's **origin** is recorded **at the moment the guard lets the window
  close**, never read later: by `will-quit`, `quitState.quitting` is always `true` (on Linux `window-all-closed`
  calls `app.quit()` after any close). The guard records it in both places it allows a close — the path with
  nothing to ask, and the answer "close" — as `restart` for `closeForRestart`, else `user` (a window close or
  `closeForQuit`) when `quitting` is not set, else `signal` (logout, `kill`: `before-quit` came first, the guard's
  existing rule). The first record wins; a later `before-quit` does not overwrite it. Only `user` and `restart`
  install; `signal` never does (a session manager may `SIGKILL` a slow logout).

In `will-quit` (one-shot), when the origin is `user` (switch on) or `restart` (switch irrelevant), and the state is
`ready`:

1. **Preconditions**, each a reason not to install (recorded, U6): the downloaded file exists and is a regular file
   (`electron-updater` verified its SHA-512 when it was downloaded, and re-verifies a cached one at each check); `$APPIMAGE` still has the `dev` / `ino` / `size` / `mtimeMs` recorded at startup (if
   `install:desktop` or the user replaced it, we do not overwrite their newer file with ours).
2. **Destination**: `$APPIMAGE` when its basename has no `x.y.z`; else `dirname/Spekterm-<new>.AppImage`
   (the user's versioned naming is kept, as `electron-updater` does).
3. **Stage**: copy the downloaded file to `<destination dir>/.<basename>.installing` (same directory → same file
   system), give it the old file's mode (the user may have chosen 0700), `fsync`. All of `will-quit`'s work is
   synchronous, including writing `installOutcome`. A staging file left by a `SIGKILL` is removed at the next
   startup.
4. **Commit**: `renameSync(staging, destination)` — atomic; renaming over the running image is allowed (the running
   mount holds the old inode), unlike writing into it (`ETXTBSY`). If the destination differs from `$APPIMAGE`, the
   old file is unlinked **after** the rename. Any failure before the rename removes the staging file and leaves
   `$APPIMAGE` untouched. After a successful rename the downloaded copy in the updater cache is deleted (~130 MB
   that would otherwise stay until the next version's download).
5. **Restart only**: relaunch the file that now exists — the destination if the commit succeeded, else `$APPIMAGE`
   (checked with `existsSync`) — through a detached `/bin/sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 0.2;
   done; exec "$2"' sh <pid> <path>`, with an explicit environment object built from `process.env` (never mutating
   `process.env`, which `secret-scope.test.mjs` guards), `stdio: 'ignore'`, `unref()`. It starts the new image only
   after this process has exited, so the two instances never share the user-data directory. **`app.relaunch` is not
   used: measured, it starts nothing inside an AppImage** (task 1.1).

The new image is never executed during the install (no `APPIMAGE_EXIT_AFTER_INSTALL` run): nothing needs FUSE until
the relaunch, and a quit-install starts nothing at all.

**Measured (tasks 1.x, 2026-10-21)**: renaming over the running AppImage leaves the running app unharmed to its
exit; `app.relaunch` starts nothing inside an AppImage, from `will-quit` or before the quit; the detached shell
starts the new image once, 1.7 s after the old one's exit, in a mount of its own; `SIGTERM` quits with exit code 0
after `before-quit`, which is why the origin is read from the event order.

*Alternative*: `quitAndInstall(true, true)` after the guard confirms. Rejected: it spawns the new app while the old
one is still quitting (two instances on one userData), its `before-quit` is a second, unguarded path into the quit,
and its installer has the defects in Context.

### U5. The switch

A new preferences group `updates` with one field `autoCheck` (boolean, on by default: stored by deleting the
field, as `gpuAcceleration`), with its own field table bound by `satisfies` and projected like the others
(`settings-projection.test.mjs`), no version bump. **Off means nothing happens without a click**: no scheduled
check, no download, and no install at a quit the user started; an update downloaded before the switch went off is
applied only by "Restart to update". Turning it on schedules a check 60 s later. About has no restore-defaults
control (`terminal-preferences` delta).

### U6. Persisted state

`<userData>/update-state.json`: `{ notifiedVersion?, lastCheckedAt?, installOutcome? }`, written file-first then
assigned. Unreadable or malformed → empty (worst case: one repeated notification). `installOutcome` (`{ version,
ok, reason? }`) is written in `will-quit` before the relaunch and shown once in About by the next start (failure:
"the update to 0.2.18 could not be installed: …"), then cleared. The downloaded file is `electron-updater`'s
(`~/.cache/spekterm-updater/pending`): after a restart without installing, the next check re-hashes it and is
`ready` again without a download.

### U7. Where the user sees it

- **One OS notification per version**, when an update becomes `ready` (installing) or `available` (telling) and
  `notifiedVersion` differs: "spekterm 0.2.18 is ready — restart to update" / "spekterm 0.2.18 is available". Both
  strings are in the two dictionaries (main-process user-visible copy, category 2–3 of the i18n rules). Clicking it
  brings the window forward, closes the inbox if open, and opens Settings at About. It goes through the same backend
  selection as the intake notifications (real packaged, stub under the probes' gate), via a small `update-notify.ts`,
  not `IntakeNotifier` (whose keys and burst limits are intake items').
- **Settings → About**, below the build identity: the status line (last check time through `locale.ts`), progress
  while downloading, "Check now", "Restart to update" (installing, `ready`) or "Download" (telling, `available`;
  `shell.openExternal` of the link U2 built), and the switch "Check for updates automatically" with a hint naming
  GitHub.
- **No status-bar field and no activity-bar badge**: `status-bar` forbids constant fields and follows the focused
  session; an app-level, once-per-release event does not belong there.
- In development mode without a probe feed, About keeps saying "development build" and shows no update controls.

### U8. IPC surface

`src/main/ipc/update.ts`, channels `workspace:update:{get,check,restart,openRelease}` (handle) and
`workspace:update:changed` (push; the listener drops the event object per `preload-listener-source.test.mjs`),
plus `workspace:update:showAbout` (push, from the notification). The renderer sends no URL, version or path:
`openRelease` opens the link the main process built; `restart` refuses unless the state is `ready`. The preload
gains an `update` namespace and `settings.setUpdateCheck`; `probe:shell`'s whitelist gains both with their
justification comments.

### U9. How it is accepted without a release

- **Unit**: the coordinator (states, fake clock, switch semantics, no check while ready, notified-version,
  failure mapping), version parsing and comparison, the release check's parsing, the backend choice (each failing
  condition including `appimage_extracted_`), the guard's restart intent and quit origin, the install sequence with
  a fake `fs` (versionless and versioned destination, missing download, replaced `$APPIMAGE`, failure before and
  after the rename, relaunch target), and the release script.
- **Probe feed override.** An unpackaged build reads `<userData>/update-feed.json` **only when `!app.isPackaged`**
  (the notification stub's pattern — not an environment variable, which `ptyEnv()` would spread into every pty). It
  names a `generic` feed URL, the release-API URL, a first-check delay, and an `app-update.yml` path that the
  installing backend passes as `updateConfigPath` with `forceDevUpdateConfig = true` (otherwise
  `electron-updater` reads `dev-app-update.yml` from the repo root). That file declares an `updaterCacheDirName`
  of its own, and the probe also sets `XDG_CACHE_HOME` to a scratch directory, so a probe never touches the
  maintainer's `~/.cache/spekterm-updater`.
- **Probe sections** (in `probe:workspace`, which already drives Settings), against a feed on `127.0.0.1`: a fake
  "AppImage" is a shell script that appends a marker line with its version when run; `APPIMAGE` points to an older
  fake in a scratch directory; `APPDIR` is unset. Sections: downloading then ready, one notification (stub);
  restart with a running session asks, Cancel leaves the file byte-identical; Restart replaces it and the
  relaunched process appended exactly one marker of the new version; a quit by closing the window installs and
  appends no marker; switch off → closing the window leaves the file unchanged and the feed saw no request; a feed
  whose `sha512` is wrong → failed, no restart offered; notified-version survives a restart (no second
  notification); activating the notification opens About; the telling backend shows "Download" against a stub
  release API. The relaunch section requires task 1.1's result (if the fallback is used, it is the fallback that is
  probed).
- **`probe:package`** (the real AppImage): seeds the switch **off** in its profile (otherwise each run would contact
  GitHub), and gains one section with it on, the first-check delay at its real value, and every host mapped to a
  local SNI listener: the listener sees a TLS client hello for `github.com` — the positive control that the packaged
  build really checks. The section with it off sees nothing past the first check's window. ("No connection to a
  non-GitHub host" is green even if absent — the listener never completes TLS — and is registered as such.)
- **Dogfood** (the only real carrier of the whole path): the first version carrying this change released with the
  script and installed with `install:desktop`; the next one released; the running one downloads, notifies, restarts
  into it with sessions restored. The macOS telling path on the build Mac against the real API.

### U10. Releasing: `npm run release:github`

`scripts/release-github.mjs --notes-file <path>` (the notes stay hand-written):

- **Release commit**: HEAD's subject is `chore(release): <version>` and its diff against its parent is exactly the
  version files — the rule in `release-check.mjs`, moved into a platform-independent function in
  `scripts/lib/release-files.mjs` that does not require a clean working tree (the maintainer's tree is rarely clean;
  `dist:mac` keeps its own clean-tree rule). **Pushed**: `git merge-base --is-ancestor HEAD origin/master` after
  `git fetch origin master` — only the exit code is read.
- **Assets**: this version's AppImage **and** `latest-linux.yml` (refuses if only one is present, if the yml's
  `version` differs from `package.json`, or if its `sha512` is not the AppImage's), and the dmg if present.
- **Invisible until complete**: a new release is created as a **draft** with all assets (`gh release create
  v<version> --draft --target <sha> --title "spekterm <version>" --notes-file …`), then published with `gh release
  edit v<version> --draft=false`. Drafts are not returned by `releases/latest`, so no client sees a release whose
  AppImage is still uploading. An existing release gets `gh release upload --clobber` (how the dmg is added from the
  Mac; the AppImage and yml are only replaced together). Afterwards `git fetch --tags` so the local `v<version>` tag
  exists for `site/scripts/check-content.mjs` (the tag `gh` creates is lightweight; the earlier ones are annotated —
  nothing reads the difference).
- `gh` and `git` are invoked with argument arrays, never a shell string, and git output is read with `--no-color`
  where it is read at all.

Packaging itself never publishes: `dist:linux` and `package-mac.mjs` pass `--publish never` explicitly
(electron-builder publishes on its own when it sees CI and a tag, and the GitHub provider is now meaningful), and
`packaging-config.test.mjs` asserts it. The script is never chained into `dist:linux`; the release order in
CONTRIBUTING becomes dist:linux → install:desktop → push → release:github. `prune-release.mjs` keeps leaving
`latest-linux.yml` alone; it is always the latest build's.

## Risks / Trade-offs

- **[A compromised GitHub account ships code to every Linux install, unattended]** → Inherent in the GitHub
  provider; the SHA-512 only protects the transfer. Stated on the data and network page. Mitigation outside the code:
  2FA on the account. A signature of our own is a Non-Goal.
- **[A newer release appears while one is ready]** → No check while ready (U3); the install's preconditions check
  the downloaded file exists (U4.1). Both unit-tested; the first also probed (a second feed version during ready).
- **[The maintainer's own `install:desktop` is overwritten by an older ready update at quit]** → The startup
  identity of `$APPIMAGE` is compared before installing (U4.1).
- **[A user who renamed the AppImage with a version in its name]** → It becomes `Spekterm-<new>.AppImage` in the same
  directory and the old file is removed after the rename; a launcher pointing at the old name breaks. Documented on
  the install page; `install:desktop`'s versionless name is unaffected.
- **[The relaunch depends on `/bin/sh` and `kill -0`]** → Both are POSIX and present wherever an AppImage runs;
  `app.relaunch` was measured not to work inside an AppImage (1.1), so there is no Electron-native path.
- **[Re-uploading the AppImage and yml of an existing release with `--clobber` is not atomic]** → A client
  checking in between sees a checksum mismatch, shows `failed` and retries at the next check. Accepted.
- **[A large copy at quit]** → The copy is within one directory's file system but from the cache, which may be on
  another file system; ~130 MB at disk speed, once per release, after the windows are gone. Accepted.
- **[GitHub's unauthenticated API limit (60/h per IP) on macOS]** → One request per 6 h per install; a 403 is
  `failed` ("rate limited"), retried at the next interval.
- **[An unpackaged build gains a feed override]** → Gated by `!app.isPackaged`; a unit test reads the gate. The
  packaged build never opens the file.
- **[The startup no-connection guarantee is weakened]** → Only for the update check, only packaged, only with the
  switch on, never within the first minute after the restore; the requirement names the exception and
  `probe:package` carries both directions.

## Migration Plan

- The first version carrying this change is installed by hand once (nothing older checks). From then on every
  release must go through the script, or Linux clients see no update (never a broken one).
- Rollback: a release that breaks updating is followed by a fixed release only if the broken one can still
  download; otherwise users reinstall from the website. Turning the switch off is the user's escape.

## Open Questions

- The check interval (6 h) and first delay (60 s) can be tuned after dogfood; the specs bound the delay from below
  only ("not within the first minute after the window restored") and say "periodically".
