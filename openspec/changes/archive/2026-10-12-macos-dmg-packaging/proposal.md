## Why

spekterm ships only a Linux AppImage, while PRD §3.3 targets macOS, Windows, and Linux, and the README and
the website say macOS "is not supported yet". On 2026-10-08 a trial build on an Apple Silicon Mac
(macOS 13.7) showed that most of the gap is packaging. With the existing `package.json` and only
command-line overrides (`electron-builder --mac dir --arm64`), the app started and passed a basic hands-on
test, and the `darwin-arm64` `node-pty` binaries were in the bundle.

The same build showed what keeps it from being something a user can install:

- **A downloaded copy would not open.** Its binaries carry only the linker's ad-hoc signatures, and the
  bundle itself is not sealed (`Sealed Resources=none`; `codesign --verify --deep --strict`: "code has no
  resources but signature indicates they must be present"). A browser download carries the quarantine
  flag, and on Apple Silicon macOS reports such an app as **"damaged"**. It opened on the build machine
  only because a local build has no quarantine flag.
- **Nothing in the repo describes it**: no macOS target, installer image, command, acceptance, or
  install instructions.
- **Some behaviour designed on Linux changes meaning on macOS** (below), and a few Linux-only mechanisms
  degrade there.

A paid Apple Developer ID (US$99/year) lets macOS open an app without a warning, and macOS auto-update
needs one. This change does **not** buy one. A valid **ad-hoc** signature turns "damaged" into
"unidentified developer": the user allows the app once in System Settings. That is the bar here.

## What Changes

**The macOS artifact**

- A new `npm run dist:mac`, run **on a Mac**, produces `release/Spekterm-<version>-arm64.dmg`:
  Apple Silicon only, with an **ad-hoc signature that seals the whole bundle**. The settings live in
  `package.json` `build.mac` / `build.dmg`, next to the Linux ones; the icon comes from
  `build/icon.png`.
- **The Mac build follows the Linux version; it builds only release commits.** `dist:linux` stays the
  only command that bumps and commits the version, and a release is always built on Linux first.
  `dist:mac` refuses to run unless the working tree is clean **and** `HEAD` is the
  `chore(release): <version>` commit for the version `package.json` declares. A clean tree alone is not
  enough: master moves on after a bump while the declared version stays the same, so a Mac build from
  any later commit would claim a version whose source it does not have. (The trial build is exactly
  that case: `0.2.3`, nine commits after the 0.2.3 bump.) Iterating on a Mac during development uses
  the packaging step without the release check (`npm run build && node scripts/package-mac.mjs`), which is
  documented as not a release.
- Pruning of old artifacts covers the `.dmg` and its `.blockmap`.
- The Electron binary is verified against the checksums the `electron` npm package ships, even when it
  is downloaded through a mirror (`ELECTRON_MIRROR`). The GitHub download was too slow to finish from the
  build machine, and a mirror that also serves the checksums would otherwise be trusted on its own word.
- The licence texts required at "the artifact root" sit in the `.app` bundle's `Contents/Resources/`.
  Measured: at the top of `Contents/` they make signing fail. Electron's and Chromium's own licence
  texts are added to them; the Linux AppImage carries both today, and the trial `.app` carries neither.

**Behaviour that changes meaning on macOS**

- **The application menu.** Every platform removes the native menu today. On macOS that also removes
  the standard shortcuts that come from menu roles: `Cmd+C` / `Cmd+V` / `Cmd+X` / `Cmd+A` in ordinary
  text fields, and `Cmd+Q`. This is known Electron behaviour, not yet checked on this app. On macOS the
  app gets a **minimal app menu and Edit menu**, set once for the process rather than per window. The
  terminal handles `Cmd+V` itself without preventing the default, so an Edit menu risks **pasting twice
  into the terminal**. The acceptance checks that one paste pastes once.
- **Quitting.** The close guard asks about running sessions only when the quit starts with closing the
  window, and it recognises that case by event order. On macOS, `Cmd+Q`, the Dock's Quit, logout, and
  shutdown all reach the app as a quit request, which this order test cannot tell apart from a signal.
  - `Cmd+Q` and the app menu's Quit become a menu item that **closes the window first**, so they ask
    exactly as closing the window does.
  - **The Dock's Quit, logout, and shutdown do not ask**, the same as `SIGTERM` on Linux. The existing
    rule that a quit nobody may be there to answer must not be held applies to them too. An unattended
    restart for a system update is the case it protects.
- **Closing the window keeps the app running, as macOS terminal apps do** (Terminal, iTerm2). Closing
  still ends every session and still asks first. Activating the app opens a new window that restores the
  sessions as dormant, as a restart does. The `darwin` branches for this exist but have never run,
  because on Linux the process ends with its window. Making the path work means:
  - setting the menu once instead of in `createWindow`;
  - releasing the per-window conversation tracking when a window is destroyed (only the reload path
    releases it today);
  - making a notification click open a window when there is none (today it does nothing).

  Hiding the window and keeping the sessions running, the way chat apps do, was considered and set
  aside: it would redesign the close confirmation, and the app's behaviour while its window is invisible
  has no acceptance today.

**Acceptance**

- An acceptance that runs on the Mac against the **app inside the mounted dmg**, launched with the
  minimal environment a Finder or Dock launch gets. `open` passes the caller's environment on, so a
  launch from the probe's shell would carry its `PATH`, which `desktop-packaging` forbids as a
  substitute.
- It covers what `probe:package` covers on Linux, read through macOS means instead of `/proc` and
  `xvfb`:
  - the renderer loads;
  - the production CSP applies;
  - a pty is spawned and a command sent to it runs;
  - an agent session resolves `claude`;
  - the bundle's signature verifies (the trial build is the control for this one).
- It also covers the new macOS behaviour:
  - menu shortcuts in text fields;
  - a single paste in the terminal;
  - `Cmd+Q` asking;
  - close → activate → sessions restored as dormant, with the menu still present in the second window.
- **Left to dogfood, and written into the spec as gaps:**
  - what a quarantined (downloaded) copy shows: "unidentified developer", not "damaged";
  - whether updating from one ad-hoc build to the next makes macOS ask again for permissions such as
    notifications, protected folders, or the keychain. Each ad-hoc build has a different identity;
  - whether notifications appear at all from an ad-hoc signed app.

  The acceptance runs on macOS 13.7 only. The minimum the build declares is macOS 12, and macOS 15
  changed the steps for allowing an unidentified app. The docs state which version was tested.

**Documentation**

- README (both languages) and the website (both languages) state the macOS install, including:
  - the "unidentified developer" step;
  - what to do if macOS still says "damaged";
  - the minimum macOS version;
  - where the app keeps its data;
  - the known macOS limitations.
- Every "macOS is not supported yet" changes: README, landing page and its download button, install,
  FAQ, troubleshooting, and the website's content check.

**Known limitations on macOS, documented and tracked as issues, not fixed here**

- A session's current directory is read from `/proc`. On macOS:
  - a restored shell restarts in its folder's root rather than its last directory;
  - the status bar loses the focused session's branch;
  - the close dialog's "shells restart in their last directory" is not true there. This change makes
    the dialog's wording true per platform.
- Automatic hibernation of idle shells needs `/proc` too, so idle shells are never hibernated
  automatically.
- The monospace font list needs `fc-list`, which macOS does not have. The Settings font field is a
  list, so on macOS it offers only the system default monospace font.
- `Ctrl+↑` / `Ctrl+↓` (move between rail items) are taken by Mission Control and App Exposé in macOS's
  default settings.
- `npm run dev` shares the packaged app's data directory, because Electron ignores `XDG_CONFIG_HOME` on
  macOS.
- No desktop integration command (`install:desktop`); dragging the app to Applications is the macOS
  install.

**Not in this change**

- **Developer ID signing, notarization, and auto-update** (paid account). The same goes for **Homebrew**:
  its main cask repository is disabling casks that fail Gatekeeper, as an ad-hoc app does. A
  self-hosted tap would still deliver an app that needs the same manual allow step.
- **Intel Macs (x64)**: no Intel Mac to accept it on, and this repo does not ship an artifact nothing has
  run.
- **Building on CI** (GitHub's macOS runners): a follow-up, not a prerequisite.
- **Windows.**
- **Trimming other platforms' `node-pty` binaries from the artifacts.** Measured, they add about 0.9 MB to
  a 133 MB AppImage and a 297 MB app; the large Windows files are already left out.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `desktop-packaging`:
  - adds the macOS artifact: dmg, arm64, a sealed ad-hoc signature, its own command, no native rebuild,
    `node-pty` loads and spawns a real pty, accepted from a desktop launch's environment;
  - Electron checksum verification;
  - pruning that covers the dmg;
  - the macOS prerequisites and escape hatches in the README;
  - the macOS acceptance gaps;
  - the "configuration lives in `package.json`" scenario and the config guard extend to the macOS target;
  - the development data-directory isolation and the desktop-integration command are stated as Linux-only,
    with the macOS gap named.
- `build-identity`: the bump stays with `dist:linux`; `dist:mac` packages only the release commit of the
  declared version on a clean tree, and the version appears in the dmg's file name.
- `workspace-app-shell`:
  - menu removal becomes per platform;
  - `Cmd+Q` and the app menu's Quit go through the close confirmation;
  - "A quit that does not start with closing the window does not ask about sessions" extends to the
    Dock's Quit, logout, and shutdown on macOS;
  - closing the window on macOS ends the sessions but leaves the app running;
  - activating it reopens the window with the sessions restored;
  - a quit that had to wait for an answer finishes once it is answered;
  - the close dialog's wording, both where shells restart and what is closing, is true per platform.
- `project-license`: where the licence texts sit inside a macOS app bundle, and Electron's and Chromium's
  licence texts are among them.
- `status-bar`: the working-directory field is a documented macOS gap; its scenarios are accepted on Linux.
- `ui-localization`: the macOS application menu becomes a sixth kind of user-visible copy.
- `project-website`: the platform status on the landing page (and the product-specific requirement that
  quotes it) says macOS builds are available, with the macOS limitations.

## Impact

- **Packaging**:
  - `package.json`: `build.mac`, `build.dmg`, `build.afterPack`, the licences moved to
    `build.linux.extraFiles`, the `dist:mac` script, and `@electron/get` as a devDependency (already
    installed as `electron`'s dependency; now declared);
  - new `scripts/release-check.mjs`, `scripts/package-mac.mjs`, and `scripts/after-pack.cjs`;
  - `scripts/prune-release.mjs`.
- **Main process**:
  - `src/main/index.ts`: the menu set once per platform, `window-all-closed` / `activate`, and
    `ensureWindow` for notification clicks;
  - `src/main/close-guard.ts`: the quit intent and its completion;
  - `src/main/ipc/terminal.ts`: releasing conversation tracking on window destroy;
  - `src/main/terminal.ts`: the `ptyCwdReadable` predicate;
  - `src/main/ipc/settings.ts`: rebuilding the menu on language change;
  - a renderer-ready IPC in the preload allow-list;
  - the close dialog's copy and the menu labels in both dictionaries.
- **Renderer**: `src/renderer/src/shell/terminal/xterm.ts`, if the double paste is real; sending the
  ready signal.
- **Tests and acceptance**:
  - `scripts/packaging-config.test.mjs`, `scripts/prune-release.test.mjs`, `scripts/site-boundary.test.mjs`,
    and the close-guard and quit tests;
  - new `scripts/probe-package-mac.mjs` (`probe:package:mac`), run on the Mac, with its ports in
    `scripts/lib/ports.mjs`;
  - `scripts/scenario-coverage.test.mjs` registration.
- **Documentation**:
  - `README.md`, `README.zh-TW.md`;
  - `site/src/content/docs/**` in both languages: landing page, documentation home, install, first
    workspace, terminals and sessions, settings, keyboard shortcuts, inbox and Slack, data and network,
    FAQ, troubleshooting;
  - `site/scripts/check-content.mjs`;
  - `docs/PRD.md` §11 Phase 6;
  - `CLAUDE.md`: the build command and the macOS caveats now tested.
- **Build machine**: the maintainer's Mac over SSH. The macOS acceptance needs a one-time Accessibility
  and Automation permission there, and a logged-in, unlocked screen.
