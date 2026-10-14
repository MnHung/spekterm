# spekterm

**English** | [繁體中文](README.zh-TW.md)

An agent-first local development workbench. spekterm hosts [Claude Code](https://code.claude.com/docs)
sessions for each repository in a single window, and puts an [OpenSpec](https://github.com/Fission-AI/OpenSpec)-aware
side panel right next to them — so you can drive your agents and read the change they're working on
without opening an IDE.

**Website and documentation: [spekterm.com](https://spekterm.com)** — the user guide lives at
[spekterm.com/docs](https://spekterm.com/docs/).

![spekterm: a Claude Code session in the conversation view, next to the side panel showing the tasks of the OpenSpec change it is working on](site/src/assets/screenshots/en/hero.png)

> **Status:** early. Builds are available for Linux (x86_64) and for macOS on Apple Silicon; Windows and
> Intel Macs are not supported yet. Auto-update is not available yet, and the macOS build is not notarized
> by Apple (it is signed ad hoc — see [macOS](#macos)).

## Why

Running several agents at once usually means a stack of terminal tabs and an editor you switch to just
to read the spec. spekterm's value over "four terminal tabs" is the side panel: it understands OpenSpec
— the change a session is working on, its artifacts, its tasks, and its specs — and follows along as the
agent writes to disk.

## What it does

- **Workspace** — any number of repositories in one window, a global session for everything else.
- **Real terminals** — `claude` and your shell in real ptys, several per repository; sessions survive a
  restart and can be hibernated.
- **OpenSpec side panel** — the change a session is working on, its artifacts and tasks, browse, graph,
  and timeline, worktrees included.
- **Conversation view, inbox, and handoffs** — read an agent as messages; Slack mentions become inbox
  items; agents can hand work to another repository.
- **Remote access** (off by default) — a paired phone reaches spekterm directly, with no relay: sessions,
  conversations, the inbox, and a notice when an agent waits for you. The Android app is in development; the
  protocol is in [`docs/remote-protocol.md`](docs/remote-protocol.md).

Everything is described in the [documentation](https://spekterm.com/docs/), including
[keyboard shortcuts](https://spekterm.com/docs/reference/keyboard-shortcuts/),
[troubleshooting](https://spekterm.com/docs/help/troubleshooting/), and
[what spekterm connects to](https://spekterm.com/docs/reference/data-and-network/).

## Requirements

- Linux x64 with `libfuse2` (needed to run AppImages; Ubuntu 22.04+ no longer installs it by default).
  Without it the AppImage fails with `dlopen(): error loading libfuse.so.2`; run it without FUSE instead:
  `./Spekterm-<version>.AppImage --appimage-extract-and-run`.
- Or macOS 12 (Monterey) or later on Apple Silicon. Tested on macOS 13 (Ventura) and macOS 27.
- [Claude Code](https://code.claude.com/docs) (`claude` on your `PATH`) for agent sessions. spekterm runs
  the real CLI with your own subscription — it never asks for an API key.

## Install

### Linux

Download the latest `Spekterm-<version>.AppImage` from the
[Releases page](https://github.com/spekhq/spekterm/releases), then:

```bash
chmod +x Spekterm-<version>.AppImage
./Spekterm-<version>.AppImage
```

spekterm keeps its data in `~/.config/Spekterm`.

### macOS

Download the latest `Spekterm-<version>-arm64.dmg` from the
[Releases page](https://github.com/spekhq/spekterm/releases), open it, and drag **Spekterm** to
**Applications**. That is the install; there is no `install:desktop` on macOS.

- **First launch.** The app is not notarized (that needs a paid Apple Developer ID); it is signed ad hoc,
  so macOS blocks it as coming from an unidentified developer. On macOS 14 and earlier, Control-click
  (right-click) the app in Applications → **Open** → **Open**; or try to open it, then
  **System Settings → Privacy & Security → Open Anyway**. On macOS 15 and later the Control-click route
  is gone: try to open it once, then **System Settings → Privacy & Security → Open Anyway**, and confirm
  with your password. This happens once per installed version.
- **"Spekterm is damaged and can't be opened."** Remove the quarantine flag, then open it again:
  `xattr -dr com.apple.quarantine /Applications/Spekterm.app`.
- **Privacy prompts name Spekterm.** macOS attributes to spekterm the prompts caused by programs running
  in its sessions — an agent reading under your home directory may trigger prompts for Calendars, Photos,
  Contacts, Reminders, Desktop, Documents, or Downloads. Denying them is safe unless one of your
  repositories lives in that protected place (a repository in Documents needs Documents access).
- **Updates.** Each build is a new identity to macOS, so after installing a new version macOS may ask
  again for permissions you granted before, including those privacy prompts.
- **Data** lives in `~/Library/Application Support/Spekterm`.
- **Closing the window** ends every session (asking first if any is running) but leaves spekterm running
  in the Dock, as Terminal and iTerm2 do; click the Dock icon to get the window back with the sessions
  restored as dormant. While it runs without a window, the inbox and the Slack check (every five minutes,
  if configured) keep running. `Cmd+Q` asks like closing the window; quitting from the Dock, logging out,
  or shutting down does not ask about running sessions (it still asks about unsaved files).

Known limitations on macOS: restored shells restart in their folder, not their last directory, and the status
bar does not show the focused session's working directory or git state ([#67](https://github.com/spekhq/spekterm/issues/67)); idle shells are never hibernated
automatically, though hibernating by hand works ([#68](https://github.com/spekhq/spekterm/issues/68)); the font setting offers only the system default monospace
font ([#69](https://github.com/spekhq/spekterm/issues/69)); `Ctrl+↑` / `Ctrl+↓` are taken by Mission Control and App Exposé in macOS's default settings (turn
them off in System Settings → Keyboard → Keyboard Shortcuts → Mission Control; [#71](https://github.com/spekhq/spekterm/issues/71)); there is no `Cmd+W` —
close a session with `Ctrl+Shift+W`. See the [install guide](https://spekterm.com/docs/getting-started/install/#install-on-macos).

## Install from source

You'll need Node.js 22 (see [`.nvmrc`](.nvmrc)). The first packaging needs network access: it downloads
the Electron binary.

```bash
git clone https://github.com/spekhq/spekterm.git
cd spekterm
npm install
npm run build && npx electron-builder --linux   # → release/Spekterm-<version>.AppImage
npm run install:desktop                          # → ~/.local/bin + your applications menu
```

`install:desktop` can be re-run while spekterm is open; the running app keeps working. To remove it,
run `npm run uninstall:desktop`.

### On macOS

Building the macOS artifact needs a Mac. `npm run dist:mac` builds a release: it refuses to run unless the
checkout is a clean release commit (`chore(release): <version>`), then runs `npm ci`, builds, verifies the
Electron archive against a pinned checksum, and packages `release/Spekterm-<version>-arm64.dmg`. It needs
network access for the Electron archive.

```bash
npm run dist:mac                                   # at a release commit → release/Spekterm-<version>-arm64.dmg
npm run build && node scripts/package-mac.mjs      # a trial build at any other commit — not a release
```

A trial build is not a release: its **Settings → About** reports uncommitted changes, if there are any.
Where GitHub's Electron download is too slow, point `ELECTRON_MIRROR` at a mirror (for example
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`). It applies to `npm ci` / `npm install` as well
as to packaging, and the pinned checksum still applies.

## Documentation

- [spekterm.com/docs](https://spekterm.com/docs/) — the user guide, in English and Traditional Chinese.
- [`docs/PRD.md`](docs/PRD.md) — product requirements, roadmap, and architecture decisions.
- [`docs/workspace-mockup.html`](docs/workspace-mockup.html) — the interactive UI mockup.
- [`CLAUDE.md`](CLAUDE.md) and [`docs/lessons/`](docs/lessons/) — working notes for contributors and
  agents, including the failures that were silent the first time.
- [`openspec/`](openspec/) — specs and the full history of changes.

Much of the existing documentation is in Traditional Chinese; new documentation is written in English.

## Relationship to spek

[spek](https://github.com/spekhq/spek) is spekterm's sibling project, from the same maintainers: an
open-source, read-only viewer for OpenSpec content — in your browser, in VS Code, in a JetBrains IDE, or as
a static page your CI builds. spekterm's side panel stands on spek's work:

- **The engine that reads OpenSpec** — scanning specs and changes, task progress, and worktree aggregation
  come from [`@spekjs/core`](https://www.npmjs.com/package/@spekjs/core).
- **The Graph and the Timeline** — the same components spek draws, from
  [`@spekjs/ui`](https://www.npmjs.com/package/@spekjs/ui).

The side panel itself is spekterm's own, made for a narrow column next to a terminal. Use spek to read
specs where you already work; use spekterm when you drive agents across repositories and want the spec
beside them. They read the same files, and neither needs the other. spek's website is
[spekterm.com/spek](https://spekterm.com/spek/).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues
privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](./LICENSE). Packaged builds also include `THIRD_PARTY_LICENSES.txt`, which lists every
third-party package bundled into the app and its license.

## Disclaimer

spekterm is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by
Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC. OpenSpec is a separate project by its own
authors.
