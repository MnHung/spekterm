---
title: Install
description: Download spekterm for Linux (an AppImage) or for macOS on Apple Silicon (a dmg), and start it.
sidebar:
  order: 1
---

spekterm has builds for Linux on x86_64, distributed as an AppImage (one file that runs without installing
anything system-wide), and for macOS on Apple Silicon, distributed as a disk image (`.dmg`). Windows and
Intel Macs are not supported yet.

## Requirements

- **Linux on x86_64.** The AppImage needs `libfuse2` to run. Ubuntu 22.04 and later no longer install it
  by default — see [If the AppImage does not start](#if-the-appimage-does-not-start).
- **macOS 12 (Monterey) or later on a Mac with Apple Silicon.** It has been tested on macOS 13 (Ventura).
  See [Install on macOS](#install-on-macos).
- **Claude Code** for agent sessions: the `claude` command must be on your `PATH`. spekterm runs the real
  CLI with your own login and subscription; it never asks for an API key. Shell sessions work without it.
- **OpenSpec** is optional. The side panel reads the `openspec/` directory of your repositories directly;
  a few details, such as the order of a change's artifacts, come from the `openspec` CLI when it is
  installed. Without an `openspec/` directory you still get terminals and the Files view.

## Download and run on Linux

1. Open the [latest release](https://github.com/spekhq/spekterm/releases/latest) and download
   `Spekterm-<version>.AppImage`.
2. Make it executable and start it:

   ```bash
   chmod +x Spekterm-<version>.AppImage
   ./Spekterm-<version>.AppImage
   ```

The first start opens an empty workspace. Continue with [Your first workspace](/docs/getting-started/first-workspace/).

spekterm reads your shell environment once when it starts (your login shell's `PATH`, and the variables
your agent sessions need). If you change your `.zshrc` or `.bashrc`, restart spekterm for new sessions to
see the change. On macOS, closing the window does not quit spekterm: quit it with `Cmd+Q`, then open it
again.

## If the AppImage does not start

If you see an error like `dlopen(): error loading libfuse.so.2`, the AppImage cannot mount itself.
Either install the library:

```bash
sudo apt install libfuse2
```

or run the AppImage without FUSE, which unpacks it to a temporary directory first:

```bash
./Spekterm-<version>.AppImage --appimage-extract-and-run
```

Both work; installing `libfuse2` makes every start faster. More problems and fixes are on the
[Troubleshooting](/docs/help/troubleshooting/) page.

## Add it to your applications menu

On Linux, the AppImage runs from wherever you put it. If you build spekterm from source, the repository has
a command that installs the built AppImage into `~/.local/bin` and adds an entry, with its icon, to your
desktop's applications menu:

```bash
git clone https://github.com/spekhq/spekterm.git
cd spekterm
npm install
npm run build && npx electron-builder --linux   # → release/Spekterm-<version>.AppImage
npm run install:desktop                          # → ~/.local/bin + your applications menu
```

You need Node.js 22 to build. The first packaging run downloads the Electron binary, so it needs network
access. To remove the menu entry and the installed copy, run `npm run uninstall:desktop`.

This command applies to Linux. On macOS there is nothing to add: dragging spekterm to Applications
installs it.

## Install on macOS

1. Open the [latest release](https://github.com/spekhq/spekterm/releases/latest) and download
   `Spekterm-<version>-arm64.dmg`.
2. Open the dmg and drag **Spekterm** to **Applications**. That is the whole install.
3. Open spekterm from Applications. The first time, macOS stops it — see the next section.

### The first launch

spekterm is not notarized by Apple: that needs a paid Apple Developer ID, which the project does not have.
The app is signed ad hoc instead, so the first time you open it, macOS blocks it as coming from an
unidentified developer. Allow it once:

- **On macOS 14 (Sonoma) and earlier:** in Applications, Control-click (or right-click) Spekterm,
  choose **Open**, then **Open** again in the dialog. Or try to open it normally, then go to
  **System Settings → Privacy & Security** and click **Open Anyway**.
- **On macOS 15 and later**, the Control-click route no longer exists. Try to open spekterm once, then go
  to **System Settings → Privacy & Security**, click **Open Anyway**, and confirm with your password.

This happens once for each version you install.

### If macOS says the app is damaged

If macOS says that Spekterm "is damaged and can't be opened", remove the quarantine flag your browser put
on the download, then open it again:

```bash
xattr -dr com.apple.quarantine /Applications/Spekterm.app
```

### Privacy prompts that name spekterm

macOS attributes to spekterm the privacy prompts caused by the programs running in its sessions. An agent
that reads under your home directory, for example, may make macOS ask whether **Spekterm** may access your
Calendars, Photos, Contacts, Reminders, Desktop, Documents, or Downloads. Denying them is safe, unless one
of your repositories lives in that protected place: a repository in `Documents` needs Documents access.

### What works differently on macOS

- **Closing the window does not quit spekterm.** As in Terminal and iTerm2, closing the window ends every
  session (asking first if any is running) and leaves spekterm running in the Dock. Click its Dock icon to
  open the window again, with the sessions restored as dormant. While spekterm runs without a window, the
  inbox keeps receiving and, if you set up Slack, it keeps checking for mentions every five minutes. To
  quit, use `Cmd+Q` or **Spekterm → Quit Spekterm**; see
  [Terminals and sessions](/docs/using/terminals-and-sessions/#closing-and-quitting-on-macos).
- **A minimal menu bar**: the **Spekterm** menu (About, Hide, Hide Others, Show All, Quit) and the
  **Edit** menu (Undo, Redo, Cut, Copy, Paste, Select All). There is no `Cmd+W`; close a session with
  `Ctrl+Shift+W`, as on Linux.

Known limitations on macOS:

- A restored shell restarts in its folder, not in its last directory. The close dialog says so ([#67](https://github.com/spekhq/spekterm/issues/67)).
- The status bar does not show the focused session's working directory or its git state ([#67](https://github.com/spekhq/spekterm/issues/67)).
- Idle shells are never hibernated automatically. Hibernating by hand works ([#68](https://github.com/spekhq/spekterm/issues/68)).
- The font setting offers only the system's default monospace font ([#69](https://github.com/spekhq/spekterm/issues/69)).
- `Ctrl+↑` / `Ctrl+↓` (move between rail items) are taken by Mission Control and App Exposé in macOS's
  default settings. To use them in spekterm, turn those shortcuts off in **System Settings → Keyboard →
  Keyboard Shortcuts → Mission Control** ([#71](https://github.com/spekhq/spekterm/issues/71)).
- There is no desktop-integration command (`npm run install:desktop` is for Linux); dragging the app to
  Applications installs it.

## Where spekterm keeps its data

Everything spekterm remembers — your folder list, sessions, side panel positions, preferences, the inbox —
lives in one directory:

- on Linux, `~/.config/Spekterm`;
- on macOS, `~/Library/Application Support/Spekterm`.

Nothing is written into your repositories. Removing that directory resets spekterm to a fresh install; it
does not touch your code.

## Updating

There is no automatic update yet. Download the new version from the
[latest release](https://github.com/spekhq/spekterm/releases/latest): on Linux, run the new AppImage in
place of the old one; on macOS, drag the new Spekterm to Applications, replacing the old one, and
[allow it once](#the-first-launch) as for the first install. Your data carries over. **Settings → About**
shows which version you are running.

On macOS, each build is a new app to the system, so after an update macOS may ask again for permissions you
granted before, including the [privacy prompts](#privacy-prompts-that-name-spekterm).
