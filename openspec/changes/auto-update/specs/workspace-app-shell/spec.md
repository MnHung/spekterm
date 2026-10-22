## MODIFIED Requirements

### Requirement: The browser engine opens no connection at startup that nothing asked for

The app SHALL NOT use Electron's built-in spell checker, and SHALL NOT download its dictionaries. With a
fresh user-data directory, and with one an earlier version left behind, starting the app SHALL NOT make
the browser engine open any network connection. Afterwards, every connection the browser engine opens is
one the user asked for, configured, or that content the user opened requests (for example a remote image
in a markdown file) — or the update check (`app-update`), which is the only exception: it is made only by a
packaged build, only while the automatic check is on (the default) or after the user chose "Check now", only
to GitHub, and never within the first minute after the window first restored its sessions.

The spell checker was on by default and downloaded a dictionary from a third-party server at every start
with a fresh profile, before the user touched anything, for a feature no part of the app uses.

Dictionary files downloaded by earlier versions MAY remain in the user-data directory; they are not used.
The `Dictionaries` directory itself may still be created, so its absence is not evidence of anything.

This requirement's check covers the browser engine's network stack only, for host names other than
`localhost`, within a bounded window after startup. Connections made by the main process's own code are
covered by "The app's own code connects only where its allow-list says"; connections to IP literals do not
pass through host-name resolution and are not observed. The update check's connection is accepted on the
packaged artifact (`app-update`); the check below runs an unpackaged build, which makes no update check.

#### Scenario: Startup with a fresh profile opens no connection

- **WHEN** the app is started with a fresh user-data directory, every host name except `localhost`
  resolving to a local listener that was already listening before the app started, and is left untouched
  for the settle window
- **THEN** the listener has received no connection

#### Scenario: Startup with an earlier version's profile opens no connection

- **WHEN** the app is started the same way with a user-data directory in which an earlier version
  registered a spell-check dictionary that is not present on disk (never downloaded, or deleted)
- **THEN** the listener has received no connection

#### Scenario: The check can see a connection

- **WHEN**, in the same run and after the settle window, the app's window loads an image from a remote
  `https:` host
- **THEN** the listener receives a connection for that host — so a check that saw nothing above was not
  blind

#### Scenario: A packaged build with the check off opens no connection

- **WHEN** the packaged artifact is started with every host name except `localhost` resolving to a local
  listener, a user-data directory in which the automatic update check is turned off, and is left untouched past
  the first update check's window
- **THEN** the listener has received no connection
