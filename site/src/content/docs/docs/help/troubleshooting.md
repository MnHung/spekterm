---
title: Troubleshooting
description: Fixes for the problems people run into most.
sidebar:
  order: 1
---

## The AppImage won't start (Linux)

If starting it prints `dlopen(): error loading libfuse.so.2`, your system is missing `libfuse2`, which
AppImages need (Ubuntu 22.04 and later no longer install it by default). Install it:

```bash
sudo apt install libfuse2
```

Or run the AppImage without FUSE:

```bash
./Spekterm-<version>.AppImage --appimage-extract-and-run
```

## `claude` is not found when spekterm is started from the desktop menu

A program started from the desktop menu (or, on macOS, from the Dock or Finder) does not inherit your
terminal's environment. spekterm reads your login shell's environment once when it starts, and uses its
`PATH` to find `claude`. So:

- make sure your shell's startup files add the directory that contains `claude` to `PATH` (for zsh,
  `.zshrc` or `.zprofile`);
- **restart spekterm** after changing them. The environment is read once at startup, so opening a new
  session is not enough. On macOS, closing the window does not quit spekterm: quit it with `Cmd+Q`.

## A change to my shell environment does not show up

Same cause: spekterm reads your environment once, at startup. Quit spekterm and start it again (on
macOS, `Cmd+Q`; closing the window is not enough).

## The side panel or the file tree stops updating

On Linux, the likely cause is an inotify watch limit that is too low. The error, `ENOSPC`, shows up only in
spekterm's standard error output. Check the limit:

```bash
cat /proc/sys/fs/inotify/max_user_watches
```

If it is 8192, raise it:

```bash
echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/60-inotify.conf
sudo sysctl --system
```

## macOS: "Spekterm cannot be opened because it is from an unidentified developer"

spekterm is not notarized by Apple, so macOS blocks its first launch. Allow it once:

- **On macOS 14 (Sonoma) and earlier:** in Applications, Control-click (or right-click) Spekterm, choose
  **Open**, then **Open** again. Or try to open it, then click **Open Anyway** in **System Settings →
  Privacy & Security**.
- **On macOS 15 and later:** try to open it once, then go to **System Settings → Privacy & Security**,
  click **Open Anyway**, and confirm with your password.

This happens once for each version you install. See
[Install on macOS](/docs/getting-started/install/#install-on-macos).

## macOS: "Spekterm is damaged and can't be opened"

The download carries a quarantine flag. Remove it, then open spekterm again:

```bash
xattr -dr com.apple.quarantine /Applications/Spekterm.app
```

## macOS asks whether Spekterm may access my Calendars, Photos, or Documents

When a program running in a spekterm session causes a privacy prompt, macOS shows the prompt in
spekterm's name. For example, an agent reading files under your home directory may trigger prompts for
Calendars, Photos, Contacts, Reminders, Desktop, Documents, or Downloads. Denying them is safe, unless one
of your repositories is in that protected location: a repository in `Documents` needs Documents access. You can change your answer
later in **System Settings → Privacy & Security**.

## macOS asks again for permissions after an update

Each build of spekterm is a new app to macOS, so after you install a new version, macOS may ask again for
permissions you granted before, including the privacy prompts above. Grant them again as before.

## `Ctrl+↑` / `Ctrl+↓` do nothing on macOS

In macOS's default settings, Mission Control and App Exposé take these keys before spekterm sees them.
Turn those shortcuts off in **System Settings → Keyboard → Keyboard Shortcuts → Mission Control**.

## Which build am I running?

**Settings → About** shows the version, build time, and commit. Include them when you report a problem
on [GitHub](https://github.com/spekhq/spekterm/issues).
