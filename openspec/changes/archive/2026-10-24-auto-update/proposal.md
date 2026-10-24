## Why

Every spekterm release today reaches its users only if they notice it: the website links to the latest GitHub
release, and the app says nothing. Builds come several times a week (0.2.14 → 0.2.17 in two days, two of them released), so most
running copies are behind, and a fix that shipped looks like a fix that did not. `docs/PRD.md` §11 lists
auto-update as an optional Phase 6 item and says it "needs" Developer ID signing — which is true of macOS only.
The Linux AppImage can replace itself without any signature, and macOS can at least be told.

The maintainer's rulings (2026-10-20):

- **Linux installs, macOS only tells.** The Linux AppImage downloads the new version in the background and
  installs it; the macOS build, ad-hoc signed, cannot be installed by Electron's updater (Squirrel.Mac requires a
  Developer ID signature), so it says a new version exists and links to its release.
- **The check is on by default and can be turned off** in Settings.
- **A downloaded update is applied only when the user chooses "Restart to update"**, which asks exactly like
  closing the window. If they never choose it, it is applied at the next quit they start.

## What Changes

- **A packaged build checks GitHub Releases of `spekhq/spekterm` for a newer version**: shortly after startup,
  then every few hours, and whenever the user asks ("Check now"). Nothing else is contacted. An unpackaged build
  (`npm run dev`, `electron .` in the probes) never checks.
- **On Linux, when the app runs from an AppImage it can replace**, a newer version is downloaded in the
  background with `electron-updater` (new dependency, used to check, download and verify only — never to
  install) and verified against the SHA-512 the release publishes.
  Once it is ready, the app says so (one OS notification per version, and the About section of Settings).
- **"Restart to update" goes through the close guard**: the same confirmation as closing the window while
  sessions hold a process or files are unsaved, then — once the window has closed — the app replaces its
  AppImage itself (a copy next to it, then one atomic rename, so there is never a moment without a runnable
  file) and starts again, its sessions restored as after any restart. Cancelling leaves everything as it was,
  the file included. `electron-updater`'s own installer is not used: `quitAndInstall()` replaces the file before
  it quits and its quit starts with `before-quit`, which the guard reads as a signal; its installer deletes the
  old file before moving the new one in, and its install-at-quit fires on a logout too.
- **An update not applied by hand is applied at the next quit the user started** (closing the window), without
  starting the app again — not at a quit started by a signal (logout, `kill`), and not when the AppImage was
  replaced by someone else meanwhile (`install:desktop`).
- **On macOS, and on Linux when the AppImage cannot be replaced** (not run from an AppImage, its directory not
  writable, or started with `--appimage-extract-and-run`), the app only tells: the same notification and About entry, with "Download", which opens the
  release page in the user's browser.
- **Settings → About** gains the update status (up to date / checking / downloading / ready / available / failed,
  with the time of the last check), "Check now", "Restart to update" or "Download", and the switch "Check for
  updates automatically" (on by default; a new preference block, no version bump of `preferences.json`).
- **The startup no-connection requirement gains its one exception**: the update check, made only by a packaged
  build with the switch on. The network allow-list gains the updater module's entries.
- **Releasing**: electron-builder already writes `latest-linux.yml` (the GitHub provider is inferred from
  `repository`); a new `npm run release:github` creates the `v<version>` release and uploads the AppImage with
  `latest-linux.yml` (and the dmg, when it is there), so a release cannot reach Linux users without the file
  the updater reads. CONTRIBUTING documents it.
- **Documentation in both languages**: the website's data and network page, the landing page and install page
  stop saying "no update check" / "no automatic update yet" and state what is checked, when, from where, and how
  to turn it off; the READMEs, `docs/PRD.md` and `CLAUDE.md` follow.

## Capabilities

### New Capabilities

- `app-update`: checking for a newer release, downloading and installing it on Linux, telling on macOS (and on a
  Linux build that cannot replace itself), the restart that applies it through the close guard, installing at
  the next quit the user starts, the Settings controls and status, the notification, and the release assets the check
  reads.

### Modified Capabilities

- `workspace-app-shell`: "The browser engine opens no connection at startup that nothing asked for" admits the
  update check of a packaged build with the switch on, and only it.
- `project-website`: "The documentation states the app's network behavior" names the update check (what, when,
  where to, how to turn it off).
- `desktop-packaging`: the release of a version publishes the update metadata with its Linux artifact, through a
  project script.
- `terminal-preferences`: the About section's content, its lack of a restore control, and opening Settings from
  an update notification closing the inbox first.

## Impact

- **Code**: new `src/main/update-*.ts` (coordinator, `electron-updater` adapter for Linux, release-API check for
  macOS, our own copy-and-rename install, persisted state), `src/main/ipc/update.ts`, the preload `update` namespace, the close
  guard's new restart intent (`src/main/close-guard.ts`, `close-prompt.ts`, `src/main/index.ts`), the
  preferences store's new block (`preferences-store.ts`, `ipc/settings.ts`, `PreferencesProvider.tsx`),
  `AboutSection.tsx`, both dictionaries.
- **Dependencies**: `electron-updater` in `dependencies` (main is externalized; in `devDependencies` the packaged
  app would fail with `MODULE_NOT_FOUND`).
- **Guards and probes**: `scripts/network-surface.test.mjs` allow-list entries; `scripts/probe-shell.mjs` preload
  whitelist; `scripts/settings-projection.test.mjs`; new probe sections against a local update feed (unpackaged,
  gated off in packaged builds) and new unit tests; `scripts/scenario-coverage.test.mjs` registers the change.
- **Release flow**: `scripts/release-github.mjs` and its test, the release-commit rule moved into
  `scripts/lib/release-files.mjs` (platform-independent, no clean-tree requirement), `package.json` script,
  `CONTRIBUTING.md`.
- **Docs**: `site/src/content/docs/**` (en + zh-tw: data-and-network, index, install), `README.md`,
  `README.zh-TW.md`, `docs/PRD.md`, `CLAUDE.md`, a new `docs/lessons/update.md` for the measured updater
  behavior.
- **Trust**: the integrity of an update is that of the GitHub release (the SHA-512 comes from the same release
  as the file). Whoever can publish a release of `spekhq/spekterm` can run code on every Linux install — the same
  trust a user already gives the download link, now exercised without their click.
