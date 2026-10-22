## Purpose

Keeps a packaged spekterm current: it checks GitHub Releases for a newer version, installs it on a Linux
AppImage when the user restarts (or when the user next closes its window), and on every other build says that a newer version
exists and links to it.

## ADDED Requirements

### Requirement: A packaged build checks GitHub Releases for a newer version

A packaged build SHALL check for a newer release of `spekhq/spekterm` on GitHub: not within the first minute
after its window first restored its sessions, then periodically while it runs, and after the computer wakes from sleep when the last
check is older than the period. The check SHALL contact only GitHub. An unpackaged build (development mode,
the acceptance probes) SHALL NOT check, except against a local feed that an acceptance probe configures, which a
packaged build SHALL ignore.

A newer version is one whose numeric `major.minor.patch` is greater than the running version. Drafts and
pre-releases are not candidates. While an update is ready to install, the app SHALL NOT check again; a newer
release is found after the ready one is installed.

#### Scenario: A packaged build checks after startup

- **WHEN** a packaged build starts with the automatic check on and every host name resolves to a local listener
- **THEN** within the first check's window the listener receives a connection for `github.com`, and no
  connection for a host that is not GitHub's

#### Scenario: An unpackaged build does not check

- **WHEN** an unpackaged build starts without a feed configured by a probe
- **THEN** it makes no update request

#### Scenario: A packaged build ignores the probe's feed

- **WHEN** a packaged build starts with a feed file in its user-data directory
- **THEN** it reads no part of that file and checks GitHub (or nothing, with the check off)

#### Scenario: No check while an update is ready

- **WHEN** an update is ready and a scheduled check time passes
- **THEN** no update request is made and the ready update is unchanged

#### Scenario: An older or equal release is not an update

- **WHEN** the latest release's version is equal to or lower than the running version
- **THEN** the status is up to date and nothing is downloaded or announced

### Requirement: The automatic check is on by default and off means nothing happens without a click

Settings SHALL offer "Check for updates automatically", on by default. While it is off, the app SHALL NOT check,
download or install anything on its own: an update downloaded before it was turned off SHALL be installed only
when the user chooses to restart for it. Turning it on SHALL schedule a check. The setting SHALL persist across
restarts and SHALL NOT change the compatibility of the existing preferences file. "Check now" SHALL check at once
whatever the setting, and on a build that installs updates SHALL download what it finds.

#### Scenario: The check is on in a fresh profile

- **WHEN** Settings is opened in a fresh profile
- **THEN** "Check for updates automatically" is on

#### Scenario: Off makes no request

- **WHEN** the setting is off and the app runs past the first check's window and a scheduled check time
- **THEN** no update request is made

#### Scenario: Off keeps a downloaded update from installing at quit

- **WHEN** an update is ready, the setting is turned off, and the app quits normally
- **THEN** the AppImage is unchanged

#### Scenario: Check now works with the setting off

- **WHEN** the setting is off and the user chooses "Check now" while a newer release exists
- **THEN** the status becomes downloading (or available, on a build that does not install) for that version

### Requirement: A Linux AppImage that can be replaced downloads the update in the background

When the running build is a Linux AppImage whose file can be replaced (it was started from an AppImage file
at an absolute path, not extracted with `--appimage-extract-and-run`, the file exists, and its directory is
writable), a newer version SHALL be downloaded in the
background, without interrupting any session, and SHALL be accepted only if its SHA-512 matches the one the
release publishes. The downloaded update SHALL survive a restart of the app that does not install it.

#### Scenario: A newer release is downloaded and becomes ready

- **WHEN** such a build checks and a newer release exists
- **THEN** the About section shows the download's progress and then that the version is ready to install

#### Scenario: A corrupted download is not offered

- **WHEN** the downloaded file's SHA-512 does not match the release's
- **THEN** the status is failed and no restart for that update is offered

#### Scenario: A build that cannot replace its file only tells

- **WHEN** the build is a Linux AppImage whose directory is not writable, was started with
  `--appimage-extract-and-run`, or was not started from an AppImage
- **THEN** it behaves as a build that tells about updates, and downloads nothing

### Requirement: Restarting to update asks exactly like closing the window

When an update is ready, the user SHALL be able to choose "Restart to update". It SHALL first ask the questions
closing the window asks — unsaved changes, then sessions that hold a process — worded for a restart. If nothing
needs asking it SHALL go ahead at once. Cancel SHALL be the dialog's default. If the user cancels, the app, its sessions and the
AppImage file SHALL be left exactly as they were. If it goes ahead, the AppImage SHALL be replaced only after every
window has closed, in a way that never leaves the path the app will next be started from without a complete, runnable file, and without running the
new version during the replacement; the new version SHALL start once the old process has exited, with its sessions
restored as after any restart (`session-persistence`). If the installation fails, the old file SHALL be left as it
was, the old version SHALL start again, and it SHALL show why the update failed.

#### Scenario: A running session is asked about

- **WHEN** a session holds a process and the user chooses "Restart to update"
- **THEN** a dialog lists the session, says the app will restart, and offers to restart or cancel, with cancel
  the default

#### Scenario: Cancelling leaves the file untouched

- **WHEN** the user cancels that dialog
- **THEN** the session is still running and the AppImage file is byte-for-byte the one before

#### Scenario: Restarting starts the new version

- **WHEN** the user confirms
- **THEN** the AppImage file is the new version, the new version was started exactly once, after the old one
  exited, and the sessions of the old one are listed in the new one

#### Scenario: A failed installation is reported after the restart

- **WHEN** installing fails during the restart (for example, the downloaded file has disappeared)
- **THEN** the AppImage file is unchanged, the old version starts again, and its About section says the update
  failed and why

### Requirement: An update not applied by hand is applied at the next quit the user starts

While the automatic check is on, an update that is ready SHALL be installed, in the same way as for a restart,
when the app quits because the user closed its window (after that close's questions), and the app SHALL NOT start
again afterwards. It SHALL NOT be installed at a quit that did not start with the user closing the window (a
logout, a signal), nor when the AppImage file is no longer the one the app started from (it was replaced
meanwhile, for example by a newer install), nor when the downloaded file is missing.

#### Scenario: Closing the window installs

- **WHEN** an update is ready and the user closes the window, confirming the dialog
- **THEN** after the app has exited the AppImage file is the new version, and no instance was started

#### Scenario: A signal does not install

- **WHEN** an update is ready and the app receives a termination signal
- **THEN** after it has exited the AppImage file is unchanged

#### Scenario: A file replaced meanwhile is not overwritten

- **WHEN** an update is ready, the AppImage file is replaced by another build while the app runs, and the user
  closes the window
- **THEN** the AppImage file is that other build

### Requirement: A build that cannot install says that a newer version exists

On macOS, and on a Linux build that cannot replace its file, a newer release SHALL be shown as available, with
"Download", which opens that release's page on GitHub in the user's browser. The build SHALL NOT download or
install anything.

#### Scenario: macOS links to the release

- **WHEN** a macOS build checks and a newer release exists
- **THEN** the About section shows that version as available, and "Download" opens
  `https://github.com/spekhq/spekterm/releases/tag/v<version>` in the browser

### Requirement: Only a version is taken from a release

The app SHALL take from a release only its version, which SHALL have the form `x.y.z` (optionally prefixed by
`v`); any other answer SHALL be a failed check. The release's name, notes and URLs SHALL NOT be shown or opened:
every text and link the app shows for an update SHALL be built from the version. The renderer SHALL NOT be able to
make the main process open a link or install a file it names.

#### Scenario: A malformed tag fails the check

- **WHEN** the latest release's tag is not of the form `x.y.z`
- **THEN** the status is failed and nothing is announced

#### Scenario: A release's own link is not used

- **WHEN** the release's answer carries a page URL that is not GitHub's
- **THEN** "Download" opens the link built from the version, not that URL

### Requirement: The user is told once per version

When an update becomes ready (or available, on a build that does not install), the app SHALL show one native
notification for that version. It SHALL NOT notify again for the same version, across restarts. Activating the
notification SHALL bring the window forward and open Settings at its About section.

#### Scenario: One notification for a version

- **WHEN** an update to a version becomes ready, the app restarts without installing, and it becomes ready again
- **THEN** exactly one notification was shown for that version

#### Scenario: The notification opens About

- **WHEN** the user activates the notification
- **THEN** the window is in front and Settings is open at About, showing the update

### Requirement: Settings shows the update status and the controls

The About section of Settings SHALL show, in a packaged build (and in an unpackaged one given a probe's feed),
the update status — up to date, checking,
downloading with its progress, ready, available, or failed with a short reason — with the time of the last check;
"Check now"; "Restart to update" when an update is ready; "Download" when one is available; and the automatic
check setting with a hint that the check contacts GitHub. A failed check SHALL be shown there and nowhere else:
no dialog, no notification. A release that does not yet carry this platform's update file SHALL count as up to
date, not as a failure. Otherwise, in development mode, About SHALL show no update controls.

#### Scenario: Offline is a quiet failure

- **WHEN** a check fails because the network is unreachable
- **THEN** About shows the check failed and when, and no dialog or notification appears

#### Scenario: A release without this platform's file is not a failure

- **WHEN** the latest release carries no update file for this platform
- **THEN** the status is up to date

### Requirement: The documentation states how updates work

The website's install page SHALL state, in both languages: that a Linux AppImage updates itself and when the
update is applied, that a file renamed with a version in its name is replaced by a file with the new version's
name, that macOS only tells and links to the release, and how to turn the automatic check off.

#### Scenario: The install page describes updates

- **WHEN** the built site's install page is read in either language
- **THEN** it states the Linux behavior, the restart, the macOS limitation and the setting that turns it off
