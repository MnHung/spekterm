# The update check and the AppImage's self-update

Measured facts behind `auto-update` (`app-update`). Like the other lessons files, each one fails silently if
forgotten. **Re-measure on an Electron, electron-builder or `electron-updater` upgrade** — every one of them is a
behavior of a version, not a contract.

## `electron-updater` checks and downloads; it never installs

`electron-updater` 6.8.9 is used for the GitHub provider, the download and the SHA-512 check — never for the
install (`update-installer.ts` is the only importer, and its test reads the file for `install(` /
`quitAndInstall`). Its installer is unsafe here in three ways, each read from its source:

- **`AppImageUpdater.doInstall` unlinks `$APPIMAGE` before it moves the new file in.** A failure in between
  leaves the user with no AppImage at all.
- **When it finds a different version while one is downloaded, it empties its cache directory but keeps the old
  file path.** A later `install()` then unlinks the user's AppImage and fails to move a file that no longer exists.
  The coordinator therefore makes **no check while an update is ready**, and the install checks the downloaded
  file still exists.
- **`autoInstallOnAppQuit` installs on every quit with exit code 0, and registers its handler only when a download
  completes with the flag on.** A `SIGTERM` (a logout) quits with exit code 0 — measured: `before-quit` → `close` →
  `will-quit` → `quit` with 0 — so the exit code cannot tell a signal from a closed window. The flag is always off;
  the close guard records who started the close (`CloseOrigin`), and `QuitInstaller` decides.

Also measured (2026-10-21, against a local generic feed): a missing `latest-linux.yml` is
`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` (counted as up to date: a release still being assembled); a refused
connection has **no `code`**, only `net::ERR_*` in the message; a wrong `sha512` is `ERR_CHECKSUM_MISMATCH` after a
full download; a cached download is re-hashed and reported as downloaded at the next check. **Every failure arrives
twice** — as an `error` event and as the promise's rejection — so the adapter reports the rejection only and keeps
an empty `error` listener (an unheard `error` event throws).

Differential download needs the running AppImage's embedded block map and a server with `Accept-Ranges`; against
a fake AppImage or a plain server it falls back to a full download with an error line in the log. That line is
not a failure.

## Replacing the AppImage: copy beside it, then one rename

`update-install.ts` copies the downloaded file to `.<name>.installing` **in the AppImage's own directory** (same
file system, so the rename is atomic), gives it the old file's mode, `fsync`s it, and renames it over. **Renaming
over the running AppImage is harmless** (measured: the running app holds the old inode and quits normally) —
writing into it would be `ETXTBSY`. A versioned name (`Spekterm-0.2.17.AppImage`) gets a new versioned file and the
old one is unlinked only after the rename. Before any of it, the AppImage's `dev` / `ino` / `size` / `mtimeMs` must
still be what they were at startup: `install:desktop` may have put a newer build there, and an older ready update
must not overwrite it.

## `app.relaunch` starts nothing inside an AppImage

Measured with two scratch AppImages: `app.relaunch({ execPath: $APPIMAGE, args: [] })` called from `will-quit`
started nothing within 60 s — and called **before** `app.quit()` (the control), nothing either. It is not timing:
the relauncher does not survive the image being unmounted. The restart is a detached
`/bin/sh -c 'while kill -0 "$1"; do sleep 0.2; done; exec "$2"'`, which started the new image 1.7 s after the old
one's `quit`, exactly once.

**The AppImage runtime sets `APPIMAGE`, `APPDIR` and `ARGV0` for the image it starts, inherited or not** — the
relaunched instance had a new `/tmp/.mount_…` although the shell inherited the old one's environment (`OWD` is
the only one inherited). `exec` without arguments starts it normally: `AppRun` adds `--no-sandbox` itself when user
namespaces are missing. Flags the user started the app with (a dogfood `--remote-debugging-port`) are not kept.

## Measuring or probing an AppImage update without touching the real profile

`args: []` drops `--user-data-dir`, so a relaunched scratch build would start on `~/.config/Spekterm` — next to
the maintainer's running app, both writing `sessions.json`. And a packaged build's `app-update.yml` names
`spekterm-updater` as its cache, the real one's. **Isolate with environment variables, which the relaunch
inherits**: `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` at scratch directories. `probe-workspace-update.mjs` also gives
its feed an `updaterCacheDirName` of its own and removes `APPDIR` / `ARGV0` / `OWD` from the app's environment.

## The probe's feed, and what it cannot reach

An unpackaged build checks only with `<userData>/update-feed.json` from a throwaway profile (`update-feed.ts`; not
an environment variable, which `ptyEnv()` would hand to every pty). Without `updateConfigPath` +
`forceDevUpdateConfig`, `electron-updater` in an unpackaged build reads `dev-app-update.yml` from the app's
directory and fails. `probe:package` is the only carrier of "a packaged build really asks GitHub" (an SNI listener
sees `github.com`); the real release-to-release path is dogfood.
